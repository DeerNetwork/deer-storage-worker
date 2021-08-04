const { create, CID } = require("ipfs-http-client");
import { logger } from "./utils";
import config from "./config";

export type Ipfs = ReturnType<typeof makeIpfs>;

export default function makeIpfs() {
  const ipfs = create(config.ipfs.url as any);
  return {
    async pinAdd(cid: string, fileSize: number): Promise<boolean> {
      try {
        const id = new CID(cid);
        const timeout = config.ipfs.pinTimeout + (fileSize / 1024 / 200) * 1000;
        const pin = await ipfs.pin.add(cid, { timeout });
        logger.debug(`ipfs.pinAdd ${cid}`);
        return id.equals(pin);
      } catch (err) {
        throw new Error(`ipfs.pinAdd ${cid}, ${err.message}`);
      }
    },
    async pinRemove(cid: string): Promise<boolean> {
      const id = new CID(cid);
      try {
        const pin = await ipfs.pin.rm(cid);
        logger.debug(`ipfs.rmPin ${cid}`);
        return id.equals(pin);
      } catch (err) {
        if (/not pinned/.test(err.message)) {
          return true;
        }
        throw new Error(`ipfs.pinRemove ${cid}, ${err.message}`);
      }
    },
    async pinList(): Promise<string[]> {
      try {
        const list = [];
        for await (const { cid } of ipfs.pin.ls({ type: "recursive" })) {
          list.push(cid.toString());
        }
        return list;
      } catch (err) {
        throw new Error(`ipfs.pinList ${err.message}`);
      }
    },
    async pinCheck(cid: string): Promise<boolean> {
      try {
        for await (const { cid: cidObj } of ipfs.pin.ls({ type: "recursive", paths: new CID(cid), timeout: 10000 })) {
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
    },
    async size(cid: string): Promise<number> {
      try {
        const id = new CID(cid);
        const info = await ipfs.object.stat(id);
        return info.CumulativeSize;
      } catch (err) {
        throw new Error(`ipfs.size ${cid}, ${err.message}`);
      }
    },
  };
}
