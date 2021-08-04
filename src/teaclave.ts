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

export interface PrepareReportRes {
  add_files: [string, number][],
  del_files: string[],
  power: number;
  rid: number;
  sig: number[];
}

export interface TeaFile {
  cid: string;
  fileSize: number;
  committed: boolean;
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
    return this.wrapRpc("attest", () => this.api.get("/attest", { timeout: 60000 }));
  }

  public async preparePeport(files: string[]): Promise<PrepareReportRes> {
    return this.wrapRpc("preparePeport", () => this.api.post("/report/prepare", { files }));
  }

  public async commitReport(rid: number): Promise<any> {
    return this.wrapRpc("commitReport", () => this.api.post(`/report/commit/${rid}`));
  }

  public async addFile(cid: string): Promise<{ size: number }> {
    return this.wrapRpc("addFile", () => this.api.post(`/files/${cid}`));
  }

  public async delFile(cid: string): Promise<any> {
    return this.wrapRpc("delFile", () => this.api.delete(`/files/${cid}`));
  }

  public async checkFile(cid: string): Promise<TeaFile> {
    const [_, fileSize, committed] = await this.wrapRpc<[string, number, boolean]>("checkFile", () => this.api.get(`/files/${cid}/status`));
    return { cid, fileSize, committed }
  }

  public async inspectFiles(): Promise<TeaFile[]> {
    const list = await this.wrapRpc<[string, number, boolean][]>("inspectFiles", () => this.api.get("/files"));
    return list.map(([cid, fileSize, committed]) => {
      return { cid, fileSize, committed }
    });
  }

  async wrapRpc<T>(name: string, rpc: () => Promise<AxiosResponse<T>>): Promise<T> {
    try {
      const res = await rpc();
      logger.debug(
        `⚡️ Teaclave call ${name}, response: ${JSON.stringify(res.data)}`
      );
      if (res.status == 200) {
        return res.data;
      }
      logger.error(`💥 Teaclave call ${name}: ${res.data}`);
    } catch (e) {
      logger.error(`💥 Teaclave call ${name}: ${e.message}`);
      throw e;
    }
  }

}
