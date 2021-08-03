const { create, CID } = require("ipfs-http-client");
import { logger } from "./utils";
import config from "./config";

export type Ipfs = ReturnType<typeof makeIpfs>;

export default function makeIpfs() {
  const ipfs = create(config.ipfs.url as any);
  return {
    async pinAdd(cid: string): Promise<boolean> {
      const id = new CID(cid);
      const pin = await ipfs.pin.add(cid, { timeout: config.ipfs.pinTimeout });
      logger.debug(`ipfs.addPin ${cid}`);
      return id.equals(pin);
    },
    async pinRm(cid: string): Promise<boolean> {
      const id = new CID(cid);
      try {
        const pin = await ipfs.pin.rm(cid);
        logger.debug(`ipfs.rmPin ${cid}`);
        return id.equals(pin);
      } catch (err) {
        if (/not pinned/.test(err.message)) {
          return true;
        }
        throw err;
      }
    },
    async pinLs(): Promise<string[]> {
      const list = [];
      for await (const { cid } of ipfs.pin.ls({ type: "recursive" })) {
        list.push(cid.toString());
      }
      return list;
    },
    async size(cid: string): Promise<number> {
      const id = new CID(cid);
      const info = await ipfs.object.stat(id);
      return info.CumulativeSize;
    },
  };
}
