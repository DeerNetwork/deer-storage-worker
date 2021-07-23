import axios, { AxiosInstance, AxiosResponse } from "axios";
import config from "./config";
import { logger } from "./utils";

export interface SystemRes {
  cursor_committed: number;
  cursor_current: number;
  enclave: string;
  machine_id: string;
  pub_key: string;
  version: string;
}

export interface AttestRes {
  ias_body: string,
  ias_cert: string,
  ias_sig: string,
  machine_id: number[],
  sig: number[],
}

export interface PrepareRes {
  add_files: string[],
  del_files: string[],
  rid: number;
  sig: number[];
}

export default class Teaclave {
  private readonly api: AxiosInstance;
  constructor() {
    this.api = axios.create({
      ...config.teaclave,
      validateStatus: () => true,
    });
  }

  public async system(): Promise<SystemRes>  {
    return this.wrapRpc("system", () => this.api.get("/system"));
  }

  public async attest(): Promise<AttestRes> {
    return this.wrapRpc("attest", () => this.api.get("/attest"));
  }

  public async preparePeport(files: string[]): Promise<PrepareRes> {
    return this.wrapRpc("preparePeport", () => this.api.post("/report/prepare", { files }));
  }

  public async commitReport(rid: number): Promise<any> {
    return this.wrapRpc("commitReport", () => this.api.post(`/report/commit/${rid}`));
  }

  public async addFile(cid: number): Promise<any> {
    return this.wrapRpc("addFile", () => this.api.post(`/files/${cid}`));
  }

  public async delFile(cid: number): Promise<any> {
    return this.wrapRpc("delFile", () => this.api.delete(`/files/${cid}`));
  }

  public async inspectFiles(): Promise<[string, number, boolean][]> {
    return this.wrapRpc("inspectFiles", () => this.api.get("/files"));
  }

  async wrapRpc<T>(name: string, rpc: () => Promise<AxiosResponse<T>>): Promise<T> {
    try {
      const res = await rpc();
      logger.info(
        `  ↪ 💖  Call ${name}, response: ${JSON.stringify(res.data)}`
      );
      if (res.status == 200) {
        return res.data;
      }
      logger.error(`💥  Error call teaclave.${name}: ${res.data}`);
    } catch (e) {
      logger.error(`💥  Error call teaclave.${name}: ${e.toString()}`);
    }
  }

}
