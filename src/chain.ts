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

export interface FileState {
  cid: string;
  included: boolean;
  numReplicas: number;
}

export interface ReportState {
  isReported: boolean;
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

  public get account() {
    return this.keyPair.address;
  }

  public async listen() {
    await this.listenBlocks();
    await this.listenEvents();
  }
  
  public async getFileState(cid: string): Promise<FileState> {
    const maybeOrder = await this.api.query.fileStorage.fileOrders(cid);
    if (maybeOrder.isSome) {
      const order = maybeOrder.unwrap();
      const included = !!order.replicas.find(v => v.toHuman() === this.account);
      return { included, numReplicas: order.replicas.length, cid };
    } 
    const file = await this.api.query.fileStorage.storeFiles(cid);
    if (file.isNone) return null;
    return { included: false, numReplicas: 0, cid };
  }

  public async getReportState(): Promise<ReportState> {
    const [maybeNode, nextRoundAt] = await Promise.all([
      this.api.query.fileStorage.nodes(this.account),
      this.api.query.fileStorage.nextRoundAt(),
    ]);
    const node = maybeNode.unwrapOrDefault();
    this.reportState = {
      isReported: node.reported_at.gt(nextRoundAt.sub(new BN(this.constants.roundDuration))),
      rid: node.rid.toNumber(),
      reportedAt: node.reported_at.toNumber(),
      nextRoundAt: nextRoundAt.toNumber(),
    };
    return this.reportState;
  }

  public detectPeroid(now: number) {
    if (!this.reportState.isReported) {
      if (this.reportState.nextRoundAt - now < ENFORCE_R * this.constants.roundDuration) {
        return Peroid.Enforce;
      }
      const reportTime = (now - this.reportState.reportedAt) % this.constants.roundDuration;
      const r = reportTime / this.constants.roundDuration;
      if (r < ENFORCE_R) {
        return Peroid.Enforce;
      }
      if (r < PREPARE_R) {
        return Peroid.Prepare;
      } 
    }
    return Peroid.Idle;
  }

  public async getStash() {
    return await this.api.query.fileStorage.stashs(this.account);
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

  public sendTx(tx: SubmittableExtrinsic): Promise<TxRes> {
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
      logger.debug(`New block ${header.number.toString()} ${header.hash.toHex()}`);
      emitter.emit("header", header);
    });
  }

  private async listenEvents() {
    this.unsubscribeEvents = await this.api.query.system.events((events) => {
      for (const ev of events) {
        logger.debug(`New event ${JSON.stringify(ev.toHuman())}`);
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
          if (this.account === data[0].toHuman()) {
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
