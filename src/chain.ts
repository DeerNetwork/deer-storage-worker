import {
  ServiceOption,
  InitOption,
  INIT_KEY,
  STOP_KEY,
  createInitFn,
} from "use-services";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { typesBundleForPolkadot } from "@deernetwork/type-definitions";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import { DispatchError } from "@polkadot/types/interfaces";
import * as _ from "lodash";
import { ITuple } from "@polkadot/types/types";
import { Keyring } from "@polkadot/keyring";
import { KeyringPair } from "@polkadot/keyring/types";
import { sleep, hex2str, formatHexArr } from "./utils";
import { AttestRes, PrepareReportRes } from "./teaclave";
import { srvs, emitter } from "./services";
import { cryptoWaitReady } from "@polkadot/util-crypto";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  url: string;
  secret: string;
  blockSecs: number;
}

export interface ChainConstants {
  roundDuration: number;
  maxFileReplicas: number;
  effectiveFileReplicas: number;
  maxFileSize: number;
  maxReportFiles: number;
}

export interface ReportState {
  rid: number;
  nextRoundAt: number;
  reportedAt: number;
  roundReported: boolean;
  planReportAt: number;
}

export interface TxRes {
  status?: string;
  message?: string;
  details?: string;
}

export class Service {
  public constants: ChainConstants;
  public walletAddress: string;
  public blockSecs: number;
  public latestBlockNum = 0;
  public reportState: ReportState;
  public shouldReport = false;

  private args: Args;
  private provider: WsProvider;
  private api: ApiPromise;
  private wallet: KeyringPair;
  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
    this.blockSecs = this.args.blockSecs;
  }

  public async [INIT_KEY]() {
    this.provider = new WsProvider(this.args.url);
    this.api = new ApiPromise({
      provider: this.provider,
      typesBundle: typesBundleForPolkadot,
    });
    await Promise.all([this.waitSynced(), cryptoWaitReady()]);
    const keyring = new Keyring({ type: "sr25519" });
    this.wallet = keyring.createFromUri(this.args.secret);
    this.walletAddress = this.api
      .createType("AccountId", this.wallet.address)
      .toString();
    srvs.logger.info(`Wallet address: ${this.walletAddress}`);

    Promise.all([await this.syncConstants(), await this.updateReportState()]);

    this.listenBlocks();
    this.listenEvents();
  }

  public async [STOP_KEY]() {
    if (this?.api?.disconnect) {
      await this.api.disconnect();
    }
    srvs.logger.info(`Chain is disconnected`);
  }

  public async getFileOrder(cid: string) {
    return this.api.query.fileStorage.fileOrders(cid);
  }

  public async getStoreFie(cid: string) {
    return this.api.query.fileStorage.storeFiles(cid);
  }

  public numBlocksBeforeReport() {
    return this.reportState.planReportAt - this.latestBlockNum;
  }

  public async getStash() {
    return await this.api.query.fileStorage.stashs(this.walletAddress);
  }

  public async getRegister(machine: string) {
    return await this.api.query.fileStorage.registers(machine);
  }

  public async register(data: AttestRes) {
    const tx = await this.api.tx.fileStorage.register(
      formatHexArr(data.machine_id),
      data.ias_cert,
      data.ias_sig,
      data.ias_body,
      formatHexArr(data.sig)
    );
    return this.sendTx(tx);
  }

  public async reportWork(
    machine: string,
    data: PrepareReportRes,
    settleFiles: string[]
  ) {
    srvs.logger.debug(
      `Report works with args: ${machine}, ${JSON.stringify(
        data
      )}, ${JSON.stringify(settleFiles)}`
    );
    const tx = await this.api.tx.fileStorage.report(
      data.rid,
      data.power,
      formatHexArr(data.sig),
      data.add_files,
      data.del_files,
      settleFiles
    );

    return this.sendTx(tx);
  }

  public async listStoreFiles() {
    const storeFiles = await this.api.query.fileStorage.storeFiles.entries();
    return storeFiles.map((storeFile) => ({
      cid: hex2str(storeFile[0].args[0].toString()),
      storeFile: storeFile[1].unwrap(),
    }));
  }

  public async listFileOrders() {
    const fileOrders = await this.api.query.fileStorage.fileOrders.entries();
    return fileOrders.map((fileOrder) => ({
      cid: hex2str(fileOrder[0].args[0].toString()),
      fileOrder: fileOrder[1].unwrap(),
    }));
  }

  private sendTx(tx: SubmittableExtrinsic): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.provider.isConnected) {
        reject(new Error(`Chain is disconnected`));
        return;
      }
      tx.signAndSend(this.wallet, ({ events = [], status }) => {
        if (status.isInvalid || status.isDropped || status.isUsurped) {
          reject(new Error(`${status.type} transaction`));
          return;
        }

        if (status.isInBlock) {
          events.forEach(({ event: { data, method, section } }) => {
            if (section === "system" && method === "ExtrinsicFailed") {
              const [dispatchError] = data as unknown as ITuple<
                [DispatchError]
              >;
              if (dispatchError.isModule) {
                const mod = dispatchError.asModule;
                const error = this.api.registry.findMetaError(
                  new Uint8Array([mod.index.toNumber(), mod.error.toNumber()])
                );
                throw new Error(
                  `Transaction throw ${error.section}.${
                    error.name
                  }, ${error.docs.join("")}`
                );
              } else {
                throw new Error(`Transaction throw ${dispatchError.type}`);
              }
            } else if (method === "ExtrinsicSuccess") {
              resolve();
            }
          });
        }
      }).catch((e) => {
        reject(e);
      });
    });
  }

  private async listenBlocks() {
    await this.api.rpc.chain.subscribeNewHeads(async (header) => {
      this.latestBlockNum = header.number.toNumber();
      if (this.latestBlockNum % (this.constants.roundDuration / 10) === 0) {
        this.updateReportState();
      }
      this.shouldReport =
        !this.reportState.roundReported &&
        this.latestBlockNum >= this.reportState.planReportAt;

      emitter.emit("header", header);
    });
  }

  private async listenEvents() {
    await this.api.query.system.events((events) => {
      for (const ev of events) {
        const {
          event: { data, method },
        } = ev;
        if (method === "StoreFileSubmitted") {
          const cid = hex2str(data[0].toString());
          emitter.emit("file:add", cid);
        } else if (method === "StoreFileSettleIncomplete") {
          const cid = hex2str(data[0].toString());
          emitter.emit("file:add", cid);
        } else if (method === "StoreFileRemoved") {
          const cid = hex2str(data[0].toString());
          emitter.emit("file:del", cid);
        } else if (method === "FileForceDeleted") {
          const cid = hex2str(data[0].toString());
          emitter.emit("file:del", cid);
        } else if (method === "NodeReported") {
          if (data[0].eq(this.walletAddress)) {
            emitter.emit("reported");
          }
        }
      }
    });
  }

  private async updateReportState(): Promise<ReportState> {
    const [maybeNode, nextRoundAtN] = await Promise.all([
      this.api.query.fileStorage.nodes(this.walletAddress),
      this.api.query.fileStorage.nextRoundAt(),
    ]);
    const { roundDuration } = this.constants;
    const nextRoundAt = nextRoundAtN.toNumber();
    const nextNextRoundAt = nextRoundAt + roundDuration;
    const currentRoundAt = nextRoundAt - roundDuration;
    const node = maybeNode.unwrapOrDefault();
    const reportedAt = node.reportedAt.toNumber();

    let planReportAt = this.reportState?.planReportAt || 0;
    const safePlanReportAt = (maybePlanReportAt) =>
      maybePlanReportAt > nextNextRoundAt - 5
        ? _.random(nextNextRoundAt - roundDuration / 2, nextNextRoundAt - 5)
        : maybePlanReportAt;

    if (maybeNode.isNone) {
      planReportAt = this.latestBlockNum + _.random(10, 20);
    } else {
      if (planReportAt <= currentRoundAt && reportedAt < currentRoundAt) {
        planReportAt = Math.min(
          this.latestBlockNum + _.random(10, 20),
          nextRoundAt - 5
        );
      } else if (
        planReportAt <= currentRoundAt &&
        reportedAt >= currentRoundAt
      ) {
        planReportAt = safePlanReportAt(reportedAt + roundDuration);
      } else if (
        currentRoundAt < planReportAt &&
        planReportAt < nextRoundAt &&
        reportedAt < currentRoundAt
      ) {
      } else if (
        currentRoundAt < planReportAt &&
        planReportAt < nextRoundAt &&
        reportedAt >= currentRoundAt
      ) {
        planReportAt = safePlanReportAt(reportedAt + roundDuration);
      }
    }
    this.reportState = {
      rid: node.rid.toNumber(),
      nextRoundAt: nextRoundAt,
      reportedAt,
      roundReported: reportedAt !== 0 && reportedAt >= currentRoundAt,
      planReportAt: planReportAt,
    };
    srvs.logger.info(`Update report state`, this.reportState);
    return this.reportState;
  }

  private async syncConstants() {
    const keys = [
      "roundDuration",
      "maxFileReplicas",
      "effectiveFileReplicas",
      "maxFileSize",
      "maxReportFiles",
    ];
    const values = await Promise.all(
      keys.map((name) => (this.api.consts.fileStorage[name] as any).toNumber())
    );
    this.constants = keys.reduce((acc, cur, i) => {
      acc[cur] = values[i];
      return acc;
    }, {} as any);
  }

  private async waitSynced() {
    await this.api.isReady;
    const halfBlockMs = this.args.blockSecs * 500;
    while (true) {
      try {
        const [{ isSyncing }, header] = await Promise.all([
          this.api.rpc.system.health(),
          this.api.rpc.chain.getHeader(),
        ]);
        if (isSyncing.isFalse) {
          await sleep(halfBlockMs);
          const header2 = await this.api.rpc.chain.getHeader();
          if (header2.number.eq(header.number)) {
            const header3 = await this.api.rpc.chain.getHeader();
            if (header3.number.toNumber() > header.number.toNumber()) {
              this.latestBlockNum = header3.number.toNumber();
              srvs.logger.info(`Chain synced at ${this.latestBlockNum}`);
              break;
            }
          }
        }
        this.latestBlockNum = header.number.toNumber();
      } catch {}
      srvs.logger.info(`Syncing block at ${this.latestBlockNum}, waiting`);
      await sleep(halfBlockMs);
    }
  }
}

export const init = createInitFn(Service);
