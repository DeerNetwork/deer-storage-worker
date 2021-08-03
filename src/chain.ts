import { ApiPromise, WsProvider } from "@polkadot/api";
import { typesBundleForPolkadot } from "@nft360/type-definitions";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import { DispatchError } from "@polkadot/types/interfaces";
import { ITuple } from "@polkadot/types/types";
import * as BN from "bn.js";
import config from "./config";
import { logger, sleep, hex2str, formatHexArr} from "./utils";
import emitter from "./emitter";
import { AttestRes, PrepareReportRes } from "./teaclave";
import { Keyring } from "@polkadot/keyring";
import { KeyringPair } from "@polkadot/keyring/types";
import * as _ from "lodash";

export interface ChainConstants {
  roundDuration: number;
  maxFileReplicas: number;
  effectiveFileReplicas: number;
  maxFileSize: number;
  maxReportFiles: number;
}

export interface ReportState {
  reported: boolean;
  rid: number;
  reportedAt: number;
  nextRoundAt: number;
}

export interface TxRes {
  status?: string;
  message?: string;
  details?: string;
}

export enum Peroid {
  Idle,
  Prepare,
  Enforce,
}

const ENFORCE_R = 0.05;
const PREPARE_R = 0.1;

export default class Chain {
  public constants: ChainConstants;
  public keyPair: KeyringPair;
  public reportState: ReportState;
  public now: number;

  private api: ApiPromise;
  private unsubscribeEvents: () => void;
  private unsubscribeBlocks: () => void;

  public async init() {
    await this.stop();
    const chainConfig = config.chain;
    this.api = new ApiPromise({
      provider: new WsProvider(chainConfig.endpoint),
      typesBundle: typesBundleForPolkadot,
    });

    await this.waitReady();
    await this.initAccount();
    Promise.all([
      await this.syncConstants(),
      await this.getReportState(),
    ]);
  }

  public get address() {
    return this.keyPair.address;
  }

  public async listen() {
    await this.listenBlocks();
    await this.listenEvents();
  }
  
  public async getFileOrder(cid: string) {
    return this.api.query.fileStorage.fileOrders(cid);
  }

  public async getStoreFie(cid: string) {
    return this.api.query.fileStorage.storeFiles(cid);
  }

  public async getReportState(): Promise<ReportState> {
    const [maybeNode, nextRoundAt] = await Promise.all([
      this.api.query.fileStorage.nodes(this.address),
      this.api.query.fileStorage.nextRoundAt(),
    ]);
    const node = maybeNode.unwrapOrDefault();
    let reportedAt: number;
    if (maybeNode.isNone) {
      reportedAt = _.random(0, this.constants.roundDuration);
    } else {
      reportedAt = node.reported_at.toNumber();
    }
    this.reportState = {
      reported: node.reported_at.gt(nextRoundAt.sub(new BN(this.constants.roundDuration))),
      rid: node.rid.toNumber(),
      reportedAt,
      nextRoundAt: nextRoundAt.toNumber(),
    };
    return this.reportState;
  }

  public async detectPeroid(now: number) {
    if (!this.reportState.reported) {
      if (this.reportState.nextRoundAt - now < ENFORCE_R * this.constants.roundDuration) {
        return Peroid.Enforce;
      }
      const passTime = now - this.reportState.reportedAt;
      const r = 1 - passTime / this.constants.roundDuration;
      if (r < ENFORCE_R) {
        return Peroid.Enforce;
      }
      if (r < PREPARE_R) {
        return Peroid.Prepare;
      } 
    }
    if (now % (this.constants.roundDuration / 10)) {
      this.getReportState();
    }
    return Peroid.Idle;
  }

  public async getStash() {
    return await this.api.query.fileStorage.stashs(this.address);
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
      formatHexArr(data.sig),
    );
    return this.sendTx(tx);
  }

  public async reportWork(machine: string, data: PrepareReportRes, settleFiles: string[]) {
    logger.debug(`Report works with args: ${machine} ${JSON.stringify(data)}, ${JSON.stringify(settleFiles)}`);
    const tx = await this.api.tx.fileStorage.report(
      machine,
      data.rid,
      formatHexArr(data.sig),
      data.add_files,
      data.del_files,
      data.power,
      settleFiles,
    );

    return this.sendTx(tx);
  }

  public async listStoreFiles() {
    const storeFiles = await this.api.query.fileStorage.storeFiles.entries();
    return storeFiles.map(storeFile => ({ cid: hex2str(storeFile[0].args[0].toString()), storeFile: storeFile[1].unwrap() }));
  }

  public async listFileOrders() {
    const fileOrders = await this.api.query.fileStorage.fileOrders.entries();
    return fileOrders.map(fileOrder => ({ cid: hex2str(fileOrder[0].args[0].toString()), fileOrder: fileOrder[1].unwrap() }))
  }

  private sendTx(tx: SubmittableExtrinsic): Promise<TxRes> {
    return new Promise((resolve, reject) => {
      tx.signAndSend(this.keyPair, ({events = [], status}) => {
        logger.info(
          `  ↪ 💸 Transaction status: ${status.type}, nonce: ${tx.nonce}`
        );

        if (status.isInvalid || status.isDropped || status.isUsurped) {
          reject(new Error(`${status.type} transaction.`));
        } else {
        }

        if (status.isInBlock) {
          events.forEach(({event: {data, method, section}}) => {
            if (section === "system" && method === "ExtrinsicFailed") {
              const [dispatchError] = data as unknown as ITuple<[DispatchError]>;
              const result: TxRes = {
                status: "failed",
                message: dispatchError.type,
              };
              if (dispatchError.isModule) {
                const mod = dispatchError.asModule;
                const error = this.api.registry.findMetaError(
                  new Uint8Array([mod.index.toNumber(), mod.error.toNumber()])
                );
                result.message = `${error.section}.${error.name}`;
                result.details = error.docs.join("");
              }

              logger.info(
                `  ↪ 💸 ❌ Send transaction(${tx.type}) failed with ${result.message}.`
              );
              resolve(result);
            } else if (method === "ExtrinsicSuccess") {
              const result: TxRes = {
                status: "success",
              };

              logger.info(
                `  ↪ 💸 ✅ Send transaction(${tx.type}) success.`
              );
              resolve(result);
            }
          });
        } else {
        }
      }).catch(e => {
        reject(e);
      });
    });
  }

  private async stop() {
    if (this?.api?.disconnect) {
      await this.api.disconnect();
    }
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
    }
    if (this.unsubscribeBlocks) {
      this.unsubscribeBlocks();
    }
  }

  private initAccount() {
    const keyring = new Keyring({ type: "sr25519" });
    this.keyPair = keyring.createFromUri(config.mnemonic);
  }

  private async listenBlocks() {
    this.unsubscribeBlocks = await this.api.rpc.chain.subscribeFinalizedHeads(header => {
      this.now = header.number.toNumber();
      emitter.emit("header", header);
    });
  }

  private async listenEvents() {
    this.unsubscribeEvents = await this.api.query.system.events((events) => {
      for (const ev of events) {
        const { event: { data, method } } = ev;
        if (method === "StoreFileSubmitted") {
          const cid = hex2str(data[0].toString());
          emitter.emit("file:add", cid);
        } else if (method === "StoreFileSettleIncomplete") {
          const cid = hex2str(data[0].toString());
          emitter.emit("file:add", cid);
        } else if (method === "StoreFileRemoved") {
          const cid = hex2str(data[0].toString());
          emitter.emit("file:del", cid);
        } else if (method === "NodeReported") {
          if (data[0].eq(this.address)) {
            emitter.emit("reported");
          }
        }
      }
    });
  }

  private async syncConstants() {
    const keys = [
      "roundDuration",
      "maxFileReplicas",
      "effectiveFileReplicas",
      "maxFileSize",
      "maxReportFiles",
    ];
    const values = await Promise.all(keys.map(name => (this.api.consts.fileStorage[name] as any).toNumber()));
    this.constants = keys.reduce((acc, cur, i) => {
      acc[cur] = values[i];
      return acc;
    }, {} as any);
  }

  private async waitReady() {
    while (!(await this.waitApiReady())) {
      logger.info("⛓  Connection broken, waiting for chain running.");
      await sleep(config.blockSecs * 1000); 
      await this.init(); 
    }
    while (await this.isSyncing()) {
      logger.info(
        `⛓  Chain is synchronizing, current block number ${(
          await this.header()
        ).number.toNumber()}`
      );
      await sleep(6000);
    }
  }

  private async header() {
    return this.api.rpc.chain.getHeader();
  }

  private async waitApiReady() {
    try {
      await this.api.isReadyOrError;
      logger.info(`⚡️ Chain info: ${this.api.runtimeChain}, ${this.api.runtimeVersion}`);
      return true;
    } catch (e) {
      logger.error(`💥 Error connecting with chain: ${e.toString()}`);
      return false;
    }
  }

  private async isSyncing() {
    const health = await this.api.rpc.system.health();
    let res = health.isSyncing.isTrue;

    if (!res) {
      const before = await this.header();
      await sleep(config.blockSecs * 1000 / 2);
      const after = await this.header();
      if (before.number.toNumber() + 1 < after.number.toNumber()) {
        res = true;
      }
    }

    return res;
  }
}
