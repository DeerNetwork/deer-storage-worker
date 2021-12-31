import { ServiceOption, InitOption, createInitFn } from "use-services";
import axios, {
  AxiosInstance,
  AxiosRequestHeaders,
  AxiosResponse,
} from "axios";
import * as _ from "lodash";
import { srvs } from "./services";

export type Option<S extends Service> = ServiceOption<Args, S>;
export const SPEED = 1048576; // 1M/s
export const MIN_SPEED = 65536; // 64K/s
export const MAX_SPEED = 109051904; // 1G/s

export interface Args {
  baseURL: string;
  headers: AxiosRequestHeaders;
  baseTimeout: number;
}

export class Service {
  public health = true;

  private args: Args;
  private currentFile: CurrentFile;
  private speed = SPEED;
  private space = Infinity;
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
    return this.wrapRpc("system", () =>
      this.api.get("/system", { timeout: 10000 })
    );
  }

  public async attest(): Promise<AttestRes> {
    return this.wrapRpc("attest", () =>
      this.api.get("/attest", { timeout: 60000 })
    );
  }

  public async preparePeport(files: string[]): Promise<PrepareReportRes> {
    srvs.logger.debug(`teaclave.preparePeport: ${files}`);
    return this.wrapRpc("preparePeport", () =>
      this.api.post(
        "/report/prepare",
        { files },
        {
          timeout: 30000,
        }
      )
    );
  }

  public async commitReport(rid: number): Promise<any> {
    srvs.logger.debug(`teaclave.preparePeport: ${rid}`);
    return this.wrapRpc("commitReport", () =>
      this.api.post(`/report/commit/${rid}`, {
        timeout: 30000,
      })
    );
  }

  public async addFile(cid: string, fileSize: number): Promise<number> {
    try {
      const timeout = this.args.baseTimeout + (fileSize / this.speed) * 1000;
      const before = Date.now();
      this.currentFile = {
        cid,
        beginAt: before,
        endAt: before + timeout,
        fileSize,
      };
      const res = await this.wrapRpc<any>("addFile", () =>
        this.api.post(`/files/${cid}`)
      );
      const { size } = res;
      const elapse = Math.max(
        (Date.now() - before - this.args.baseTimeout) / 1000,
        0
      );
      if (elapse >= 1) {
        this.speed = _.clamp(fileSize / elapse, MIN_SPEED, MAX_SPEED);
      }
      this.currentFile = null;
      return size;
    } catch (err) {
      this.currentFile = null;
      throw err;
    }
  }

  public async delFile(cid: string): Promise<void> {
    try {
      this.wrapRpc("delFile", () =>
        this.api.delete(`/files/${cid}`, {
          timeout: 10000,
        })
      );
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
      >("existFile", () =>
        this.api.get(`/files/${cid}/status`, { timeout: 5000 })
      );
      return { cid, fileSize, committed };
    } catch (err) {
      if (/File does not exist/.test(err)) return null;
      throw err;
    }
  }

  public async listFiles(): Promise<TeaFile[]> {
    const list = await this.wrapRpc<[string, number, boolean][]>(
      "listFiles",
      () =>
        this.api.get("/files", {
          timeout: 30000,
        })
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
      srvs.logger.debug("Check tea health", {
        health: this.health,
        speed: this.speed,
        space: this.space,
      });
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
