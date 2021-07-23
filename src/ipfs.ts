import { create, CID } from "ipfs-http-client";
import config from "./config";

export default function makeIpfs() {
  const ipfs = create(config.ipfs.url as any);
  return {
    async pin(cid: string, timeout: number): Promise<boolean> {
      const id = new CID(cid);
      const pin = await ipfs.pin.add(cid, { timeout });
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
