const { create, CID } = require("ipfs-http-client");
import config from "./config";

export type Ipfs = ReturnType<typeof makeIpfs>;

export default function makeIpfs() {
  const ipfs = create(config.ipfs.url as any);
  return {
    async pin(cid: string): Promise<boolean> {
      const id = new CID(cid);
      const pin = await ipfs.pin.add(cid, { timeout: config.ipfs.pinTimeout });
      return id.equals(pin);
    },
    async unpin(cid: string): Promise<boolean> {
      const id = new CID(cid);
      const pin = await ipfs.pin.rm(cid);
      return id.equals(pin);
    },
    async size(cid: string): Promise<number> {
      const id = new CID(cid);
      const info = await ipfs.object.stat(id);
      return info.CumulativeSize;
    },
  };
}
