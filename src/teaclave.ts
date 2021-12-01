import { ServiceOption, InitOption, createInitFn } from "use-services";
import axios, {
  AxiosInstance,
  AxiosRequestHeaders,
  AxiosResponse,
} from "axios";
import { srvs } from "./services";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  baseURL: string;
  timeout: number;
  headers: AxiosRequestHeaders;
}

export interface SystemRes {
  cursor_committed: number;
  cursor_current: number;
  enclave: string;
  machine_id: string;
  pub_key: string;
  version: string;
}

export interface AttestRes {
  ias_body: string;
  ias_cert: string;
  ias_sig: string;
  machine_id: number[];
  sig: number[];
}

export interface PrepareReportRes {
  add_files: [string, number][];
  del_files: string[];
  power: number;
  rid: number;
  sig: number[];
}

export interface TeaFile {
  cid: string;
  fileSize: number;
  committed: boolean;
}

export class Service {
  private args: Args;
  private readonly api: AxiosInstance;
  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
    this.api = axios.create({
      baseURL: this.args.baseURL,
      timeout: this.args.timeout,
      headers: this.args.headers,
      validateStatus: () => true,
    });
  }

  public async system(): Promise<SystemRes> {
    return this.wrapRpc("system", () => this.api.get("/system"));
  }

  public async attest(): Promise<AttestRes> {
    return this.wrapRpc("attest", () =>
      this.api.get("/attest", { timeout: 60000 })
    );
  }

  public async preparePeport(files: string[]): Promise<PrepareReportRes> {
    return this.wrapRpc("preparePeport", () =>
      this.api.post("/report/prepare", { files })
    );
  }

  public async commitReport(rid: number): Promise<any> {
    return this.wrapRpc("commitReport", () =>
      this.api.post(`/report/commit/${rid}`)
    );
  }

  public async addFile(cid: string): Promise<{ size: number }> {
    return this.wrapRpc("addFile", () => this.api.post(`/files/${cid}`));
  }

  public async delFile(cid: string): Promise<any> {
    return this.wrapRpc("delFile", () => this.api.delete(`/files/${cid}`));
  }

  public async checkFile(cid: string): Promise<TeaFile> {
    const [, fileSize, committed] = await this.wrapRpc<
      [string, number, boolean]
    >("checkFile", () => this.api.get(`/files/${cid}/status`));
    return { cid, fileSize, committed };
  }

  public async inspectFiles(): Promise<TeaFile[]> {
    const list = await this.wrapRpc<[string, number, boolean][]>(
      "inspectFiles",
      () => this.api.get("/files")
    );
    return list.map(([cid, fileSize, committed]) => {
      return { cid, fileSize, committed };
    });
  }

  async wrapRpc<T>(
    name: string,
    rpc: () => Promise<AxiosResponse<T>>
  ): Promise<T> {
    try {
      const res = await rpc();
      srvs.logger.debug(`teaclave.${name} got ${JSON.stringify(res.data)}`);
      if (res.status == 200) {
        return res.data;
      }
      throw new Error(`teaclave.${name}: ${res.data}`);
    } catch (e) {
      throw new Error(`teaclave.${name}: ${e.message}`);
    }
  }
}

export const init = createInitFn(Service);
