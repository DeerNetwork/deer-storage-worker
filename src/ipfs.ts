import {
  ServiceOption,
  InitOption,
  INIT_KEY,
  createInitFn,
} from "use-services";
import { create, IPFSHTTPClient } from "ipfs-http-client";
import { StatResult } from "ipfs-core-types/src/object";
import { srvs } from "./services";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  url: string;
  numProvs: number;
}

export const TIMEOUT = 1000;
export const SPEED = 262144; // 256k/s

export class Service {
  public health = true;

  private args: Args;
  private client: IPFSHTTPClient;
  private currentFile: CurrentFile;
  private speed = SPEED;

  private count = 0;
  private summaryTime = 0;
  private summarySize = 0;

  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
  }

  public async [INIT_KEY]() {
    this.client = create({ url: this.args.url });
  }

  public async pinAdd(cid: string, fileSize: number): Promise<boolean> {
    try {
      const timeout = (fileSize / this.speed) * 1000;
      const now = Date.now();
      this.currentFile = { cid, beginAt: now, endAt: now + timeout, fileSize };
      await this.client.pin.add(cid, { timeout: 1.2 * timeout });
      this.count += 1;
      this.summarySize += fileSize;
      this.summaryTime += Date.now() - now;
      this.speed = this.summarySize / this.summaryTime / 1000 || SPEED;
      this.currentFile = null;
      return true;
    } catch (err) {
      this.currentFile = null;
      throw new Error(`ipfs.pinAdd ${cid}, ${err.message}`);
    }
  }

  public async pinRemove(cid: string): Promise<boolean> {
    try {
      await this.client.pin.rm(cid);
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
        timeout: TIMEOUT,
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
        timeout: TIMEOUT,
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
        timeout: TIMEOUT,
      });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return null;
      }
      throw new Error(`ipfs.object.stat ${cid}, ${err.message}`);
    }
  }

  public async existProv(cid: string): Promise<boolean> {
    const providers = this.client.dht.findProvs(cid as any, {
      timeout: TIMEOUT * 3,
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
    } catch (err) {
      srvs.logger.error(`Ipfs cheak health throws ${err.message}`);
      this.health = false;
    }
  }

  public estimateTime(fileSize: number, current = true): number {
    let time = (fileSize / this.speed) * 1000;
    if (current && this.currentFile) {
      time += Math.max(0, this.currentFile.endAt - Date.now());
    }
    return time;
  }
}

export const init = createInitFn(Service);

interface CurrentFile {
  cid: string;
  fileSize: number;
  beginAt: number;
  endAt: number;
}
