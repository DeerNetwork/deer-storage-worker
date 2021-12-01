import { ServiceOption, InitOption, createInitFn } from "use-services";
import {
  PalletStorageFileOrder,
  PalletStorageStoreFile,
} from "@polkadot/types/lookup";
import { TeaFile } from "./teaclave";
import { srvs } from "./services";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  maxRetries: number;
}

export interface File {
  reserved?: BigInt;
  expireAt?: number;
  fileSize?: number;
  countReplicas?: number;
  countIpfsFails?: number;
  reported?: boolean;
  isPinned?: boolean;
  isAdded?: boolean;
  isCommitted?: boolean;
}

export class Service {
  public files: Map<string, File> = new Map();

  private args: Args;

  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
  }

  public async run() {
    const storeFiles = await srvs.chain.listStoreFiles();
    for (const { cid, storeFile } of storeFiles) {
      this.addStoreFile(cid, storeFile);
    }
    const fileOrders = await srvs.chain.listFileOrders();
    for (const { cid, fileOrder } of fileOrders) {
      this.addFileOrder(cid, fileOrder);
    }
    const cids = await srvs.ipfs.pinList();
    for (const cid of cids) {
      this.addPin(cid);
    }
    const teaFiles = await srvs.teaclave.inspectFiles();
    for (const teaFile of teaFiles) {
      this.addTeaFile(teaFile);
    }
    for (const [cid] of this.files.entries()) {
      this.deleteDirtyFile(cid);
    }
  }

  public getFile(cid: string): File {
    return this.files.get(cid);
  }

  public async deleteDirtyFile(cid: string) {
    const file = this.getFile(cid);
    if (!file) return;
    if (!this.isFileDirty(file)) return;
    if (file.isPinned) {
      await srvs.ipfs.pinRemove(cid);
    }
    if (file.isAdded) {
      await srvs.teaclave.delFile(cid);
    }
    this.files.delete(cid);
  }

  public async getReportFiles() {
    const toCheckCids: string[] = [];
    for (const [cid, file] of this.files.entries()) {
      if (this.isFileCanReportAdd(file)) {
        toCheckCids.push(cid);
        continue;
      }
      if (this.isFileCanReportSettle(file)) {
        toCheckCids.push(cid);
        continue;
      }
    }
    await Promise.all(
      toCheckCids.map(async (cid) => {
        const maybeFileOrder = await srvs.chain.getFileOrder(cid);
        if (maybeFileOrder.isSome) {
          this.addFileOrder(cid, maybeFileOrder.unwrap());
        }
      })
    );
    const addFiles: string[] = [];
    const settleFiles: string[] = [];
    for (const [cid, file] of this.files.entries()) {
      if (this.isFileCanReportAdd(file)) {
        addFiles.push(cid);
        continue;
      }
      if (this.isFileCanReportSettle(file)) {
        settleFiles.push(cid);
        continue;
      }
    }
    return { addFiles, settleFiles };
  }

  public async getPendingFiles() {
    const ipfsFiles = [];
    const teaFiles = [];
    for (const [cid, file] of this.files.entries()) {
      if (this.isFilePendingIpfs(file)) {
        ipfsFiles.push(cid);
        continue;
      }
      if (this.isFilePendingTea(file)) {
        teaFiles.push(cid);
        continue;
      }
    }
    return { ipfsFiles, teaFiles };
  }

  public async checkDeleteCid(cid: string) {
    const file = this.getFile(cid);
    if (!file) this.files.set(cid, this.defaultFile());
    try {
      const maybeStoreFile = await srvs.chain.getStoreFie(cid);
      if (maybeStoreFile.isSome) {
        this.addStoreFile(cid, maybeStoreFile.unwrap());
        const maybeFileOrder = await srvs.chain.getFileOrder(cid);
        if (maybeFileOrder.isSome) {
          this.addFileOrder(cid, maybeFileOrder.unwrap());
        } else {
          file.countReplicas = 0;
          file.reported = false;
        }
      } else {
        file.reserved = BigInt(0);
        file.expireAt = 0;
      }
      file.isPinned = await srvs.ipfs.pinCheck(cid);
      const teaFile = await srvs.teaclave.checkFile(cid);
      if (teaFile) {
        this.addTeaFile(teaFile);
      } else {
        file.isAdded = false;
      }
    } catch (err) {
      srvs.logger.warn(`Fail to check delete cid ${cid}`);
    }
  }

  public async markFileIpfsFail(cid: string) {
    const file = this.getFile(cid);
    if (file) {
      file.countIpfsFails = file.countIpfsFails + 1;
    }
  }

  public async checkReportCids(cids: string[]) {
    for (const cid of cids) {
      try {
        const maybeFileOrder = await srvs.chain.getFileOrder(cid);
        if (maybeFileOrder.isSome) {
          this.addFileOrder(cid, maybeFileOrder.unwrap());
        }
        const teaFile = await srvs.teaclave.checkFile(cid);
        this.addTeaFile(teaFile);
      } catch (err) {
        srvs.logger.warn(`Fail to check report cid ${cid}`);
      }
    }
  }

  public addStoreFile(cid: string, storeFile: PalletStorageStoreFile) {
    const file = this.files.get(cid) || this.defaultFile();
    file.reserved = storeFile.reserved.toBigInt();
    if (!file.fileSize) file.fileSize = storeFile.fileSize.toNumber();
    this.files.set(cid, file);
  }

  public addFileOrder(cid: string, fileOrder: PalletStorageFileOrder) {
    if (this.files.has(cid)) {
      const file = this.files.get(cid);
      file.fileSize = fileOrder.fileSize.toNumber();
      file.expireAt = fileOrder.expireAt.toNumber();
      file.countReplicas = fileOrder.replicas.length;
      file.reported = !!fileOrder.replicas.find((v) =>
        v.eq(srvs.chain.address)
      );
    }
  }

  public addPin(cid: string) {
    if (this.files.has(cid)) {
      const file = this.files.get(cid);
      file.isPinned = true;
    }
  }

  public addTeaFile(teaFile: TeaFile) {
    const { cid, committed } = teaFile;
    if (this.files.has(cid)) {
      const file = this.files.get(cid);
      file.isAdded = true;
      file.isCommitted = committed;
    } else {
      this.files.set(cid, {
        ...this.defaultFile(),
        isAdded: true,
        isCommitted: committed,
      });
    }
  }

  private isFileCanReportAdd(file: File) {
    return this.isFileWorth(file) && file.isPinned && file.isAdded;
  }

  private isFileCanReportSettle(file: File) {
    return file.isCommitted && file.expireAt <= srvs.chain.now;
  }

  private isFilePendingIpfs(file: File) {
    return (
      this.isFileWorth(file) &&
      !file.isPinned &&
      file.countIpfsFails < this.args.maxRetries
    );
  }

  private isFilePendingTea(file: File) {
    return this.isFileWorth(file) && file.isPinned && !file.isAdded;
  }

  private isFileWorth(file: File) {
    return (
      !file.reported &&
      (file.countReplicas || 0) < srvs.chain.constants.maxFileReplicas
    );
  }

  private isFileDirty(file: File) {
    return (
      (file.reserved === BigInt(0) && file.expireAt < srvs.chain.now) ||
      (!file.reported &&
        file.countReplicas >= srvs.chain.constants.maxFileReplicas)
    );
  }

  private defaultFile(): File {
    return {
      reserved: BigInt(0),
      expireAt: Number.MAX_SAFE_INTEGER,
      fileSize: 0,
      countReplicas: 0,
      countIpfsFails: 0,
    };
  }
}

export const init = createInitFn(Service);
