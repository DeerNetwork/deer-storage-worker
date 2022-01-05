import "@deernetwork/type-definitions/dist/interfaces/augment-api";
import "@deernetwork/type-definitions/dist/interfaces/augment-types";

import {
  ServiceOption,
  InitOption,
  INIT_KEY,
  STOP_KEY,
  createInitFn,
} from "use-services";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { typesBundle } from "@deernetwork/type-definitions";
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
  reportBlocks: number;
}

export class Service {
  public constants: ChainConsts;
  public walletAddress: string;
  public latestBlockNum = 0;
  public reportState: ReportState;
  public health = true;
  public blockSecs: number;

  private args: Args;
  private provider: WsProvider;
  private api: ApiPromise;
  private wallet: KeyringPair;
  private startingReport = 0;

  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
    this.blockSecs = option.args.blockSecs;
  }

  public async [INIT_KEY]() {
    this.provider = new WsProvider(this.args.url);
    this.api = new ApiPromise({
      provider: this.provider,
      typesBundle,
    });
    await Promise.all([this.api.isReady, cryptoWaitReady()]);
    const keyring = new Keyring({ type: "sr25519" });
    this.wallet = keyring.createFromUri(this.args.secret);
    this.walletAddress = this.api
      .createType("AccountId", this.wallet.address)
      .toString();
    srvs.logger.info(`Wallet address: ${this.walletAddress}`);
  }

  public async [STOP_KEY]() {
    if (this?.api?.disconnect) {
      await this.api.disconnect();
    }
    srvs.logger.info(`Chain is disconnected`);
  }

  public async start() {
    await this.waitSynced();
    Promise.all([await this.syncConstants(), await this.updateReportState()]);
    this.listenBlocks();
    this.listenEvents();
  }

  public async getFile(cid: string): Promise<ChainFile> {
    const maybeFile = await this.api.query.fileStorage.files(cid);
    if (maybeFile.isNone) return;
    const file = maybeFile.unwrap();
    return {
      addedAt: file.addedAt.toNumber(),
      reserved: file.reserved.toBn().toString(),
      fileSize: file.fileSize.toNumber() || file.fileSize.toNumber(),
      fee: file.fee.toBn().toString(),
      expireAt: file.expireAt.toNumber(),
      numReplicas: file.replicas.length,
      existReplica: !!file.replicas.find((f) => f.eq(this.walletAddress)),
    };
  }

  public async batchValidateCids(
    cids: string[],
    kind: "addFiles" | "settleFiles"
  ): Promise<boolean[]> {
    if (cids.length === 0) return [];
    const maybeFiles = await this.api.query.fileStorage.files.multi(cids);
    const result: boolean[] = [];
    const { maxFileReplicas } = this.constants;
    for (let i = 0; i < cids.length; i++) {
      const file = maybeFiles[i].unwrapOrDefault();
      if (kind === "addFiles") {
        result.push(
          file.replicas.length === 0 ||
            (!file.replicas.find((v) => v.eq(this.walletAddress)) &&
              file.replicas.length < maxFileReplicas)
        );
      } else if (kind === "settleFiles") {
        result.push(
          !!file.replicas.find((v) => v.eq(this.walletAddress)) &&
            file.expireAt.toNumber() < this.latestBlockNum
        );
      }
    }
    return result;
  }

  public async getNode() {
    return await this.api.query.fileStorage.nodes(this.walletAddress);
  }

  public async getRegister(machine: string) {
    return await this.api.query.fileStorage.registers(machine);
  }

  public async getRid() {
    const node = await this.getNode();
    return node.unwrapOrDefault().rid.toNumber();
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

  public async checkHealth() {
    try {
      await this.api.rpc.system.syncState();
      this.health = true;
      srvs.logger.debug("Check chain health", {
        blockNum: this.latestBlockNum,
        health: this.health,
      });
    } catch (err) {
      srvs.logger.error(`Check chain health throws ${err.message}`);
      this.health = false;
    }
  }

  public async iterStoreFileKeys(pageSize: number, startKey?: string) {
    const keys = await this.api.query.fileStorage.files.keysPaged({
      args: [],
      pageSize,
      startKey,
    });
    return keys;
  }

  public commonProps(): CommonProps {
    const { blockSecs, latestBlockNum } = srvs.chain;
    const { planReportAt } = srvs.chain.reportState;
    const { sessionDuration, maxFileReplicas } = srvs.chain.constants;
    return {
      blockSecs,
      sessionDuration,
      latestBlockNum,
      planReportAt,
      maxFileReplicas,
    };
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
                const kind = `${error.section}.${error.name}`;
                const doc = error.docs.join("");
                const message = `Transaction throw ${kind}, ${doc}`;
                emitter.emit("fatal", message);
                throw new Error(message);
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
      if (this.latestBlockNum % (this.constants.sessionDuration / 10) === 0) {
        this.updateReportState();
      }
      const shouldReport =
        !this.reportState.sessionReported &&
        this.latestBlockNum >= this.reportState.planReportAt - 1;

      if (
        shouldReport &&
        this.latestBlockNum - this.startingReport > this.args.reportBlocks
      ) {
        srvs.engine.reportWork();
        this.startingReport = this.latestBlockNum;
      }
    });
  }

  private async listenEvents() {
    await this.api.query.system.events(async (events) => {
      for (const ev of events) {
        const {
          event: { data, method },
        } = ev;
        if (method === "FileAdded") {
          srvs.logger.debug("Listen event FileAdded", {
            event: ev.toHuman(),
          });
          const cid = hex2str(data[0].toString());
          await srvs.engine.enqueueAddFile(cid);
        } else if (method === "FileStored") {
          srvs.logger.debug("Listen event FileStored", {
            event: ev.toHuman(),
          });
          const cid = hex2str(data[0].toString());
          await srvs.engine.enqueueAddFile(cid);
        } else if (method === "FileDeleted") {
          srvs.logger.debug("Listen event FileDeleted", {
            event: ev.toHuman(),
          });
          const cid = hex2str(data[0].toString());
          await srvs.engine.enqueueDelFile(cid);
        } else if (method === "FileForceDeleted") {
          srvs.logger.debug("Listen event FileForceDeleted", {
            event: ev.toHuman(),
          });
          const cid = hex2str(data[0].toString());
          await srvs.engine.enqueueDelFile(cid);
        } else if (method === "NodeReported") {
          if (data[0].eq(this.walletAddress)) {
            srvs.logger.debug("Listen event NodeReported", {
              event: ev.toHuman(),
            });
            await this.updateReportState();
            await srvs.engine.maybeCommitReport();
          }
        }
      }
    });
  }

  private async updateReportState(): Promise<ReportState> {
    const [maybeNode, session] = await Promise.all([
      this.api.query.fileStorage.nodes(this.walletAddress),
      this.api.query.fileStorage.session(),
    ]);
    const { sessionDuration } = this.constants;
    const { reportBlocks } = this.args;
    const { beginAt, endAt } = session;
    const sessionEndAt = endAt.toNumber();
    const nextSessionEndAt = sessionEndAt + sessionDuration;
    const sessionBeginAt = beginAt.toNumber();
    const node = maybeNode.unwrapOrDefault();
    const reportedAt = node.reportedAt.toNumber();
    const bias = this.constants.sessionDuration / 20;
    const randBlocks = _.random(Math.floor(0.5 * bias), Math.ceil(1.2 * bias));

    let planReportAt = this.reportState?.planReportAt || 0;
    const safePlanReportAt = (maybePlanReportAt) =>
      maybePlanReportAt > nextSessionEndAt - reportBlocks
        ? _.random(
            nextSessionEndAt - sessionDuration / 2,
            nextSessionEndAt - reportBlocks
          )
        : maybePlanReportAt;

    if (maybeNode.isNone) {
      planReportAt = this.latestBlockNum + randBlocks;
    } else {
      if (planReportAt < sessionBeginAt && reportedAt < sessionBeginAt) {
        planReportAt = Math.min(
          this.latestBlockNum + randBlocks,
          sessionEndAt - reportBlocks
        );
      } else if (
        planReportAt < sessionBeginAt &&
        reportedAt >= sessionBeginAt
      ) {
        planReportAt = safePlanReportAt(reportedAt + sessionDuration);
      } else if (
        sessionBeginAt <= planReportAt &&
        planReportAt <= sessionEndAt &&
        reportedAt < sessionBeginAt
      ) {
      } else if (
        sessionBeginAt <= planReportAt &&
        planReportAt <= sessionEndAt &&
        reportedAt >= sessionBeginAt
      ) {
        planReportAt = safePlanReportAt(reportedAt + sessionDuration);
      }
    }
    this.reportState = {
      rid: node.rid.toNumber(),
      sessionEndAt: sessionEndAt,
      reportedAt,
      sessionReported: reportedAt !== 0 && reportedAt >= sessionBeginAt,
      planReportAt: planReportAt,
    };
    srvs.logger.info(`Update report state`, {
      rid: this.reportState.rid,
      planReportAt,
      reportedAt,
      now: this.latestBlockNum,
    });
    return this.reportState;
  }

  private async syncConstants() {
    const keys = [
      "sessionDuration",
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
    while (true) {
      try {
        const [{ isSyncing }, header] = await Promise.all([
          this.api.rpc.system.health(),
          this.api.rpc.chain.getHeader(),
        ]);
        if (isSyncing.isFalse) {
          await sleep(1000);
          const header2 = await this.api.rpc.chain.getHeader();
          if (header2.number.eq(header.number)) {
            await sleep(this.blockSecs * 1000);
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
      await sleep(this.blockSecs * 500);
    }
  }
}

export const init = createInitFn(Service);

export interface ChainConsts {
  sessionDuration: number;
  maxFileReplicas: number;
  effectiveFileReplicas: number;
  maxFileSize: number;
  maxReportFiles: number;
}

export interface ReportState {
  rid: number;
  sessionEndAt: number;
  reportedAt: number;
  sessionReported: boolean;
  planReportAt: number;
}

export interface ChainFile {
  addedAt: number;
  reserved: string;
  fileSize: number;
  fee: string;
  expireAt: number;
  numReplicas: number;
  existReplica: boolean;
}

export interface CommonProps {
  blockSecs: number;
  latestBlockNum: number;
  planReportAt: number;
  sessionDuration: number;
  maxFileReplicas: number;
}
