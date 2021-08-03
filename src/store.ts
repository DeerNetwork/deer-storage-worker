import { Ipfs } from "./ipfs";
import Chain from "./chain";
import Teaclave, { TeaFile } from "./teaclave";
import { FileOrder, StoreFile } from "@nft360/type-definitions/dist/interfaces/fileStorage";
import { logger } from "./utils";

export interface File {
  reserved: BigInt,
  updateAt: number;
  expireAt?: number;
  fileSize?: number;
  countReplicas?: number;
  reported?: boolean;
  willDelete?: boolean;
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
    const cids = await this.ipfs.pinLs();
    for (const cid of cids) {
      this.addPin(cid);
    }
    const teaFiles = await this.teaclave.inspectFiles();
    for (const teaFile  of teaFiles) {
      this.addTeaFile(teaFile);
    }
  }
  
  public getFile(cid: string): File {
    return this.files.get(cid);
  }

  public deleteFile(cid: string) {
    const file = this.getFile(cid);
    if (file) {
      file.willDelete = true;
    }
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
    if (this.files.has(cid)) {
      const item = this.files.get(cid);
      item.reserved = storeFile.reserved.toBigInt();
      item.updateAt = Date.now();
    } else {
      this.files.set(cid, {
        reserved: storeFile.reserved.toBigInt(),
        updateAt: Date.now(),
        expireAt: Number.MAX_SAFE_INTEGER,
        fileSize: 0,
        countReplicas: 0,
      })
    }
  }

  public addFileOrder(cid: string, fileOrder: FileOrder) {
    if (this.files.has(cid)) {
      const item = this.files.get(cid);
      item.fileSize = fileOrder.file_size.toNumber();
      item.expireAt = fileOrder.expire_at.toNumber();
      item.countReplicas = fileOrder.replicas.length;
      item.reported = !!fileOrder.replicas.find(v => v.eq(this.chain.address));
      item.updateAt = Date.now();
    }
  }

  public addPin(cid: string) {
    if (this.files.has(cid)) {
      const item = this.files.get(cid);
      item.isPinned = true;
      item.updateAt = Date.now();
    }
  }

  public addTeaFile(teaFile: TeaFile) {
    const { cid, committed } = teaFile;
    if (this.files.has(cid)) {
      const item = this.files.get(cid);
      item.isAdded = true;
      item.isCommitted = committed;
      item.updateAt = Date.now();
    }
  }

  private isFileCanReportAdd(file: File) {
    return  !file.reported && file.isAdded && !file.isCommitted && file.countReplicas < this.chain.constants.maxFileReplicas
  }

  private isFileCanReportSettle(file: File) {
    return !file.willDelete && file.isCommitted && file.expireAt < this.chain.now;
  }

  private isFilePendingIpfs(file: File) {
    return !file.willDelete && !file.reported && !file.isPinned && file.countReplicas < this.chain.constants.maxFileReplicas
  }

  private isFilePendingTea(file: File) {
    return !file.willDelete && !file.reported && file.isPinned && !file.isAdded && file.countReplicas < this.chain.constants.maxFileReplicas
  }

}