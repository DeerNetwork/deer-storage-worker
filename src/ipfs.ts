import {
  ServiceOption,
  InitOption,
  INIT_KEY,
  createInitFn,
} from "use-services";
import { create, IPFSHTTPClient } from "ipfs-http-client";
import { srvs } from "./services";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  url: string;
  pinTimeout: number;
  sizeTimeout: number;
}

export class Service {
  private args: Args;
  private client: IPFSHTTPClient;

  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
  }

  public async [INIT_KEY]() {
    this.client = create({ url: this.args.url });
  }

  async pinAdd(cid: string, fileSize: number): Promise<boolean> {
    try {
      const timeout = this.args.pinTimeout + (fileSize / 1024 / 200) * 1000;
      await this.client.pin.add(cid, { timeout });
      srvs.logger.debug(`ipfs.pinAdd ${cid}`);
      return true;
    } catch (err) {
      throw new Error(`ipfs.pinAdd ${cid}, ${err.message}`);
    }
  }

  public async pinRemove(cid: string): Promise<boolean> {
    try {
      await this.client.pin.rm(cid);
      srvs.logger.debug(`ipfs.rmPin ${cid}`);
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
      for await (const { cid } of this.client.pin.ls({ type: "recursive" })) {
        list.push(cid.toString());
      }
      return list;
    } catch (err) {
      throw new Error(`ipfs.pinList ${err.message}`);
    }
  }

  public async pinCheck(cid: string): Promise<boolean> {
    try {
      for await (const { cid: cidObj } of this.client.pin.ls({
        type: "recursive",
        paths: cid,
        timeout: 10000,
      })) {
        if (cidObj.toString() === cid) {
          return true;
        }
      }
    } catch (err) {
      if (/not pinned/.test(err.message)) {
        return false;
      }
      throw new Error(`ipfs.pinCheck ${err.message}`);
    }
    return false;
  }

  public async size(cid: string): Promise<number> {
    try {
      const info = await this.client.object.stat(cid as any, {
        timeout: this.args.sizeTimeout,
      });
      return info.CumulativeSize;
    } catch (err) {
      throw new Error(`ipfs.size ${cid}, ${err.message}`);
    }
  }
}

export const init = createInitFn(Service);
