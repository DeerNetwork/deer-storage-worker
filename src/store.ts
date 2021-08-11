import { Ipfs } from "./ipfs";
import Chain from "./chain";
import Teaclave, { TeaFile } from "./teaclave";
import { FileOrder, StoreFile } from "@nft360/type-definitions/dist/interfaces/fileStorage";
import { logger } from "./utils";
import config from "./config";

export interface File {
  reserved?: BigInt,
  expireAt?: number;
  fileSize?: number;
  countReplicas?: number;
  countIpfsFails?: number;
  reported?: boolean;
  isPinned?: boolean;
  isAdded?: boolean;
  isCommitted?: boolean;
}

export default class Store {
  public files: Map<string, File> = new Map();

  private chain: Chain;
  private ipfs: Ipfs;
  private teaclave: Teaclave;

  public async init(chain: Chain, ipfs: Ipfs, teaclave: Teaclave) {
    this.chain = chain;
    this.ipfs = ipfs;
    this.teaclave = teaclave;

    const storeFiles = await this.chain.listStoreFiles();
    for (const {cid, storeFile} of storeFiles) {
      this.addStoreFile(cid, storeFile);
    }
    const fileOrders = await this.chain.listFileOrders();
    for (const {cid, fileOrder} of fileOrders) {
      this.addFileOrder(cid, fileOrder);
    }
    const cids = await this.ipfs.pinList();
    for (const cid of cids) {
      this.addPin(cid);
    }
    const teaFiles = await this.teaclave.inspectFiles();
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
      await this.ipfs.pinRemove(cid);
    }
    if (file.isAdded) {
      await this.teaclave.delFile(cid);
    }
    this.files.delete(cid);
  }

  public async getReportFiles() {
    const toCheckCids = [];
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
    await Promise.all(toCheckCids.map(async cid => {
      const maybeFileOrder = await this.chain.getFileOrder(cid);
      if (maybeFileOrder.isSome) {
        this.addFileOrder(cid, maybeFileOrder.unwrap());
      }
    }));
    const addFiles = [];
    const settleFiles = [];
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
      const maybeStoreFile = await this.chain.getStoreFie(cid);
      if (maybeStoreFile.isSome) {
        this.addStoreFile(cid, maybeStoreFile.unwrap());
        const maybeFileOrder = await this.chain.getFileOrder(cid);
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
      file.isPinned = await this.ipfs.pinCheck(cid);
      const teaFile = await this.teaclave.checkFile(cid);
      if (teaFile) {
        this.addTeaFile(teaFile);
      } else {
        file.isAdded = false;
      }
    } catch (err) {
      logger.warn(`Fail to check delete cid ${cid}`);
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
        const maybeFileOrder = await this.chain.getFileOrder(cid);
        if (maybeFileOrder.isSome) {
          this.addFileOrder(cid, maybeFileOrder.unwrap());
        }
        const teaFile = await this.teaclave.checkFile(cid);
        this.addTeaFile(teaFile);
      } catch (err) {
        logger.warn(`Fail to check report cid ${cid}`);
      }
    }
  }

  public addStoreFile(cid: string, storeFile: StoreFile) {
    const file = this.files.get(cid) || this.defaultFile();
    file.reserved = storeFile.reserved.toBigInt();
    if (!file.fileSize) file.fileSize = storeFile.file_size.toNumber();
    this.files.set(cid, file);
  }

  public addFileOrder(cid: string, fileOrder: FileOrder) {
    if (this.files.has(cid)) {
      const file = this.files.get(cid);
      file.fileSize = fileOrder.file_size.toNumber();
      file.expireAt = fileOrder.expire_at.toNumber();
      file.countReplicas = fileOrder.replicas.length;
      file.reported = !!fileOrder.replicas.find(v => v.eq(this.chain.address));
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
    return file.isCommitted && file.expireAt <= this.chain.now;
  }

  private isFilePendingIpfs(file: File) {
    return  this.isFileWorth(file) && !file.isPinned  && file.countIpfsFails < config.ipfs.maxRetries;
  }

  private isFilePendingTea(file: File) {
    return this.isFileWorth(file) && file.isPinned && !file.isAdded;
  }

  private isFileWorth(file: File) {
    return !file.reported && (file.countReplicas || 0) < this.chain.constants.maxFileReplicas;
  }

  private isFileDirty(file: File) {
    return (file.reserved === BigInt(0) && file.expireAt < this.chain.now) ||
      (!file.reported && file.countReplicas >= this.chain.constants.maxFileReplicas);
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
