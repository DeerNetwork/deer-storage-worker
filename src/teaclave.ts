import { ServiceOption, InitOption, createInitFn } from "use-services";
import axios, {
  AxiosInstance,
  AxiosRequestHeaders,
  AxiosResponse,
} from "axios";
import { srvs } from "./services";

export type Option<S extends Service> = ServiceOption<Args, S>;
export const SPEED = 1048576; // 1M/s

export interface Args {
  baseURL: string;
  headers: AxiosRequestHeaders;
}

export class Service {
  public health = true;

  private args: Args;
  private currentFile: CurrentFile;
  private speed = SPEED;
  private space = Infinity;
  private count = 0;
  private summaryTime = 0;
  private summarySize = 0;
  private api: AxiosInstance;

  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
    this.api = axios.create({
      baseURL: this.args.baseURL,
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

  public async addFile(cid: string, fileSize: number): Promise<number> {
    try {
      const time = (fileSize / this.speed) * 1000;
      const now = Date.now();
      this.currentFile = { cid, beginAt: now, endAt: now + time, fileSize };
      const res = await this.wrapRpc<any>("addFile", () =>
        this.api.post(`/files/${cid}`)
      );
      const { size } = res;
      this.count += 1;
      this.summarySize += size;
      this.summaryTime += Date.now() - now;
      this.speed = this.summarySize / this.summaryTime / 1000 || SPEED;
      this.currentFile = null;
      return size;
    } catch (err) {
      this.currentFile = null;
      throw err;
    }
  }

  public async delFile(cid: string): Promise<void> {
    try {
      this.wrapRpc("delFile", () => this.api.delete(`/files/${cid}`));
      return;
    } catch (err) {
      if (/File not found/.test(err)) return;
      throw err;
    }
  }

  public async getFile(cid: string): Promise<TeaFile> {
    try {
      const [, fileSize, committed] = await this.wrapRpc<
        [string, number, boolean]
      >("existFile", () => this.api.get(`/files/${cid}/status`));
      return { cid, fileSize, committed };
    } catch (err) {
      if (/File does not exist/.test(err)) return null;
      throw err;
    }
  }

  public async listFiles(): Promise<TeaFile[]> {
    const list = await this.wrapRpc<[string, number, boolean][]>(
      "listFiles",
      () => this.api.get("/files")
    );
    return list.map(([cid, fileSize, committed]) => {
      return { cid, fileSize, committed };
    });
  }

  public estimateTime(fileSize: number, current = true): number {
    let time = (fileSize / this.speed) * 1000;
    if (current && this.currentFile) {
      time += Math.max(0, this.currentFile.endAt - Date.now());
    }
    return time;
  }

  public async checkHealth() {
    try {
      const system = await this.system();
      this.space = system.rsd_size;
      this.health = true;
    } catch (err) {
      srvs.logger.error(`Teacalve cheak health throws ${err.message}`);
      this.health = false;
    }
  }

  private async wrapRpc<T>(
    name: string,
    rpc: () => Promise<AxiosResponse<T>>
  ): Promise<T> {
    try {
      const res = await rpc();
      srvs.logger.debug(`teaclave.${name}: ${JSON.stringify(res.data)}`);
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

export interface SystemRes {
  cursor_committed: number;
  cursor_current: number;
  enclave: string;
  rsd_size: number;
  files_size: number;
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

interface CurrentFile {
  cid: string;
  fileSize: number;
  beginAt: number;
  endAt: number;
}
