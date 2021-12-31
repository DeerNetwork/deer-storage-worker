import {
  ServiceOption,
  InitOption,
  INIT_KEY,
  createInitFn,
} from "use-services";
import { AbortController } from "native-abort-controller";
import { create, IPFSHTTPClient } from "ipfs-http-client";
import { StatResult } from "ipfs-core-types/src/object";
import { srvs } from "./services";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  url: string;
  numProvs: number;
  basePinTimeout: number;
}

export class Service {
  public health = true;

  private args: Args;
  private client: IPFSHTTPClient;

  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
  }

  public async [INIT_KEY]() {
    this.client = create({ url: this.args.url });
  }

  public pinAdd(
    cid: string,
    fileSize: number
  ): [AbortController, () => Promise<boolean>] {
    const controller = new AbortController();
    const signal = controller.signal;
    const timeout =
      this.args.basePinTimeout * 60000 + (fileSize / 1024 / 200) * 1000;
    const run = async () => {
      try {
        srvs.logger.debug("ipfs.pinAdd", { cid });
        await this.client.pin.add(cid, { timeout, signal });
        return true;
      } catch (err) {
        throw new Error(`ipfs.pinAdd ${cid}, ${err.message}`);
      }
    };
    return [controller, run];
  }

  public async pinRemove(cid: string): Promise<boolean> {
    try {
      srvs.logger.debug("ipfs.pinRemove", { cid });
      await this.client.pin.rm(cid, { timeout: 10000 });
    } catch (err) {
      if (/not pinned/.test(err.message)) {
        return true;
      }
      throw new Error(`ipfs.pinRemove ${cid}, ${err.message}`);
    }
  }

  public async pinList(): Promise<string[]> {
    try {
      const list = [];
      for await (const { cid } of this.client.pin.ls({
        type: "recursive",
        timeout: 3000,
      })) {
        list.push(cid.toString());
      }
      return list;
    } catch (err) {
      throw new Error(`ipfs.pinList ${err.message}`);
    }
  }

  public async pinExist(cid: string): Promise<boolean> {
    try {
      for await (const { cid: cidObj } of this.client.pin.ls({
        type: "recursive",
        paths: cid,
        timeout: 3000,
      })) {
        if (cidObj.toString() === cid) {
          return true;
        }
      }
    } catch (err) {
      if (/not pinned/.test(err.message)) {
        return false;
      }
      throw new Error(`ipfs.pinExist ${err.message}`);
    }
    return false;
  }

  public async objectStat(cid: string): Promise<StatResult> {
    try {
      return await this.client.object.stat(cid as any, {
        timeout: 3000,
      });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return null;
      }
      throw new Error(`ipfs.object.stat ${cid}, ${err.message}`);
    }
  }

  public async existProv(cid: string): Promise<boolean> {
    srvs.logger.debug("ipfs.existProv", { cid });
    const providers = this.client.dht.findProvs(cid as any, {
      timeout: 5000,
      numProviders: this.args.numProvs,
    });
    let count = 0;
    for await (const _ of providers) { // eslint-disable-line
      count += 1;
      if (count >= this.args.numProvs) {
        return true;
      }
    }
    return false;
  }

  public async checkHealth() {
    try {
      await this.client.stats.bitswap();
      this.health = true;
      srvs.logger.debug("Check ipfs health", { health: this.health });
    } catch (err) {
      srvs.logger.error(`Cheak ipfs health throws ${err.message}`);
      this.health = false;
    }
  }
}

export const init = createInitFn(Service);
