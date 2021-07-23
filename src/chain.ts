import {ApiPromise, WsProvider} from "@polkadot/api";
import {Header, Extrinsic, EventRecord} from "@polkadot/types/interfaces";
import {typesBundleForPolkadot, nodeTypes} from "@nft360/type-definitions";
import config from "./config";
import { logger, sleep } from "./utils";
import { SECONDS_PER_BLOCK } from "./constants";

export default class Chain {
  private api: ApiPromise;
  public async init() {
    if (this?.api?.disconnect) {
      return this.api.disconnect().catch(() => {});
    }
    const chainConfig = config.chain;
    this.api = new ApiPromise({
      provider: new WsProvider(chainConfig.endpoint),
      typesBundle: typesBundleForPolkadot,
    });
    await this.api.isReady;
  }
  public async subscribeNewHeads(handler: (b: Header) => void) {
    while (!(await this.waitApiReady())) {
      logger.info("⛓  Connection broken, waiting for chain running.");
      await sleep(SECONDS_PER_BLOCK * 1000); 
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

    return await this.api.rpc.chain.subscribeFinalizedHeads((head: Header) =>
      handler(head)
    );
  }

  async header() {
    return this.api.rpc.chain.getHeader();
  }

  async waitApiReady() {
    try {
      await this.api.isReadyOrError;
      return true;
    } catch (e) {
      logger.error(`💥  Error connecting with Chain: ${e.toString()}`);
      return false;
    }
  }

  async isSyncing() {
    const health = await this.api.rpc.system.health();
    let res = health.isSyncing.isTrue;

    if (!res) {
      const before = await this.header();
      await sleep(SECONDS_PER_BLOCK * 1000 / 2);
      const after = await this.header();
      if (before.number.toNumber() + 1 < after.number.toNumber()) {
        res = true;
      }
    }

    return res;
  }
}
