import {
  ServiceOption,
  createInitFn,
  InitOption,
  STOP_KEY,
} from "use-services";
import { AbortController } from "native-abort-controller";
import PQueue from "p-queue";
import { srvs, emitter } from "./services";
import { sleep } from "./utils";
import { ChainFile } from "chain";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  iterFilesPageSize: number;
}

const WHILE_SLEEP = 2000;
const CHECK_HEALTH_SLEEP = 180000;
const IPFS_PQUEUE_CONCURRENCY = 20;

export class Service {
  private args: Args;
  private machine: string;
  private ipfsQueue: ChainFile[] = [];
  private ipfsPQueue: PQueue;
  private ipfsAbortCtrls: { [k: string]: AbortController } = {};
  private teaQueue: ChainFile[] = [];
  private delQueue: string[] = [];
  private addFiles: Set<string> = new Set();
  private onchainFiles: Map<string, number> = new Map();
  private reportFiles: string[][] = [];
  private destoryed = false;
  private reporting = false;

  constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
  }

  public async [STOP_KEY]() {
    this.destoryed = true;
  }

  public async start() {
    await srvs.chain.start();
    await this.waitTeaclave();
    this.runIpfsQueue();
    this.runTeaQueue();
    this.runDelQueue();
    this.checkHealth();
    this.iterChainFiles();
    this.iterTeaFiles();
  }

  public async reportWork() {
    try {
      srvs.logger.debug("Starting report work");
      this.reporting = true;
      await this.maybeCommitReport();
      await this.syncReportFiles();
      const [addFiles, liquidateFiles] = this.reportFiles;
      const reportData = await srvs.teaclave.preparePeport(addFiles);
      await srvs.chain.reportWork(this.machine, reportData, liquidateFiles);
      this.reportSuccess();
      srvs.logger.info("Report work successed");
    } catch (err) {
      srvs.logger.error(`Fail to report work, ${err.message}`);
    } finally {
      this.reporting = false;
    }
  }

  public async maybeCommitReport() {
    const [rid, system] = await Promise.all([
      srvs.chain.getRid(),
      srvs.teaclave.system(),
    ]);
    if (system.cursor_committed < rid) {
      await srvs.teaclave.commitReport(rid);
    } else {
      srvs.logger.debug("No need to commit report");
    }
  }

  public async enqueueAddFile(cid: string) {
    try {
      const file = await srvs.chain.getFile(cid);
      if (!file) return;
      if (this.isFileIncluded(file)) {
        return;
      }
      if (this.isFileFulled(file)) {
        return;
      }
      if (this.ipfsPQueue.size < IPFS_PQUEUE_CONCURRENCY) {
        this.ipfsPQueue.add(() => this.addIpfsFile(file));
      } else {
        this.ipfsQueue.push(file);
      }
    } catch (err) {
      srvs.logger.error(`Fail to add file ${cid}, ${err.message}`);
    }
  }

  public async enqueueDelFile(cid: string) {
    if (this.ipfsAbortCtrls[cid]) {
      this.ipfsAbortCtrls[cid].abort();
    }
    this.onchainFiles.delete(cid);
    this.addFiles.delete(cid);
    this.ipfsQueue = this.ipfsQueue.filter((v) => v.cid !== cid);
    this.teaQueue = this.teaQueue.filter((v) => v.cid !== cid);
    this.delQueue.push(cid);
  }

  private async waitTeaclave() {
    let isTeaclaveOk = false;
    do {
      if (this.destoryed) break;
      isTeaclaveOk = await this.setupTeaclave();
      if (!isTeaclaveOk) await sleep(30000);
    } while (!isTeaclaveOk);
  }

  private async setupTeaclave() {
    try {
      const maybeNode = await srvs.chain.getNode();
      if (maybeNode.isNone) {
        srvs.logger.warn("Account have not been stashed");
        return false;
      }
      const node = maybeNode.unwrap();
      if (node.machineId.isNone) {
        srvs.logger.info("Try to register teaclave");
        await this.registerNode();
        return false;
      }
      const system = await srvs.teaclave.system();
      const machine = node.machineId.unwrap().toString();
      if (machine !== "0x" + system.machine_id) {
        emitter.emit(
          "fatal",
          `Mismatch machine, onchain ${system.machine_id}, current ${machine}`
        );
        return false;
      }
      if (!system.enclave) {
        await this.registerNode();
        return false;
      }
      const maybeRegister = await srvs.chain.getRegister(machine);
      if (maybeRegister.isNone) {
        await this.registerNode();
        return false;
      }
      if (maybeRegister.unwrap().enclave.toHex() !== "0x" + system.enclave) {
        srvs.logger.warn(`Mistach enclave, try register node`);
        await this.registerNode();
        return false;
      }
      if (
        srvs.chain.reportState.rid &&
        system.cursor_committed !== srvs.chain.reportState.rid
      ) {
        srvs.logger.warn(`Last commit to submit to teaclave, try resubmit`);
        await srvs.teaclave.commitReport(srvs.chain.reportState.rid);
      }
      this.machine = machine;
      return true;
    } catch (err) {
      if (/teaclave.attest: connect ECONNREFUSED/.test(err.message)) {
        srvs.logger.warn("Waiting for teaclave ready");
        return false;
      }
      srvs.logger.error(`Fail to setup teaclave, ${err.toString()}`);
      return false;
    }
  }

  private async registerNode() {
    const attest = await srvs.teaclave.attest();
    if (!attest) {
      srvs.logger.error("Fail to fetch attest");
      return false;
    }
    try {
      await srvs.chain.register(attest);
      srvs.logger.info("Register node successful");
      return true;
    } catch (err) {
      srvs.logger.error(`Fail to register node, ${err.message}`);
      return false;
    }
  }
  private async runIpfsQueue() {
    this.ipfsPQueue = new PQueue({ concurrency: IPFS_PQUEUE_CONCURRENCY });
    while (true) {
      if (this.destoryed) break;
      if (
        this.ipfsQueue.length === 0 ||
        !srvs.ipfs.health ||
        this.ipfsPQueue.size >= IPFS_PQUEUE_CONCURRENCY
      ) {
        await sleep(WHILE_SLEEP);
        continue;
      }
      const item = this.ipfsQueue.pop();
      await this.addIpfsFile(item);
    }
  }
  private async runTeaQueue() {
    while (true) {
      if (this.destoryed) break;
      if (this.teaQueue.length === 0 || !srvs.teaclave.health) {
        await sleep(WHILE_SLEEP);
        continue;
      }
      const { maxReportFiles } = srvs.chain.constants;
      if (this.addFiles.size >= maxReportFiles) {
        await sleep(WHILE_SLEEP);
        continue;
      }

      const item = this.dequeueTea();
      await this.addTeaFile(item);
    }
  }

  private async runDelQueue() {
    while (true) {
      if (this.destoryed) break;
      if (
        this.reporting ||
        this.delQueue.length === 0 ||
        !srvs.ipfs.health ||
        !srvs.teaclave.health
      ) {
        await sleep(WHILE_SLEEP * 2);
        continue;
      }
      const cid = this.delQueue.shift();
      await this.delFile(cid);
    }
  }

  private async addIpfsFile(file: ChainFile) {
    const { cid, fileSize } = file;
    try {
      file = await srvs.chain.getFile(cid);
      if (!file) return;
      if (this.isFileIncluded(file)) return;
      const [abortCtrl, pinAdd] = srvs.ipfs.pinAdd(cid, fileSize);
      this.ipfsAbortCtrls[cid] = abortCtrl;
      await pinAdd();
      const { CumulativeSize } = await srvs.ipfs.objectStat(cid);
      file.fileSize = CumulativeSize;
      this.teaQueue.push(file);
    } catch (err) {
      srvs.logger.error(`Fail to add ipfs file ${cid}, ${err.message}`);
    } finally {
      delete this.ipfsAbortCtrls[cid];
    }
  }

  private async addTeaFile(item: QueueItem) {
    const { cid, fileSize } = item;
    try {
      const teaFile = await srvs.teaclave.getFile(cid);
      if (!teaFile) {
        await srvs.teaclave.addFile(cid, fileSize);
      }
      this.addFiles.add(cid);
    } catch (err) {
      srvs.logger.error(`Fail to add tea file ${cid}, ${err.message}`);
    }
  }

  private async delFile(cid: string) {
    try {
      const file = await srvs.chain.getFile(cid);
      if (this.isFileIncluded(file)) return;
      const teaFile = await srvs.teaclave.getFile(cid);
      if (teaFile) await srvs.teaclave.delFile(cid);
      await srvs.ipfs.pinRemove(cid);
    } catch (err) {
      srvs.logger.error(`Fail to del file ${cid}, ${err.message}`);
    }
  }

  private async iterChainFiles() {
    let cacheKey: any = null;
    try {
      while (true) {
        const entries = await srvs.chain.iterFiles(
          this.args.iterFilesPageSize,
          cacheKey
        );
        for (const entry of entries) {
          const { key, file } = entry;
          cacheKey = key;
          srvs.logger.debug("Iter chain file", { cid: file.cid });
          if (this.isFileIncluded(file)) {
            continue;
          }
          if (this.isFileFulled(file)) {
            continue;
          }
          await this.ipfsQueue.push(file);
        }
        if (entries.length === 0) break;
      }
    } catch (err) {
      srvs.logger.error(`Fail to iter chain files, ${err.message}`);
    }
  }

  private async iterTeaFiles() {
    try {
      const teaFiles = await srvs.teaclave.listFiles();
      for (const teaFile of teaFiles) {
        const { cid } = teaFile;
        srvs.logger.debug("Iter tea file", teaFile);
        const file = await srvs.chain.getFile(cid);
        if (this.isFileIncluded(file)) {
          continue;
        }
        if (this.isFileFulled(file)) {
          this.enqueueDelFile(cid);
          continue;
        }
        this.addFiles.add(cid);
      }
    } catch (err) {
      srvs.logger.error(`Fail to iter tea files, ${err.message}`);
    }
  }

  private async checkHealth() {
    while (true) {
      await sleep(CHECK_HEALTH_SLEEP);
      await Promise.all([
        srvs.chain.checkHealth(),
        srvs.ipfs.checkHealth(),
        srvs.teaclave.checkHealth(),
      ]);
    }
  }

  private async syncReportFiles() {
    const liquidateFiles: Set<string> = new Set();
    for (const [cid, expireAt] of this.onchainFiles.entries()) {
      if (expireAt < srvs.chain.latestBlockNum) {
        liquidateFiles.add(cid);
      }
    }
    const files = await srvs.chain.listFiles([
      ...Array.from(this.addFiles),
      ...liquidateFiles,
    ]);
    let reportAddFiles: string[] = [];
    let reportLiquidateFiles: string[] = [];
    for (const file of files) {
      const { cid } = file;
      if (!this.isFileLiquidated(file)) {
        reportLiquidateFiles.push(cid);
      }
      if (this.isFileIncluded(file)) {
        this.addFiles.delete(cid);
        continue;
      }
      if (this.isFileFulled(file)) {
        this.enqueueDelFile(cid);
        continue;
      }
      reportAddFiles.push(cid);
    }
    const { maxReportFiles } = srvs.chain.constants;
    reportAddFiles = reportAddFiles.slice(0, maxReportFiles);
    reportLiquidateFiles = reportLiquidateFiles.slice(0, maxReportFiles);
    this.reportFiles = [reportAddFiles, reportLiquidateFiles];
  }

  private async reportSuccess() {
    const [addFiles, liquidateFiles] = this.reportFiles;
    const files = await srvs.chain.listFiles([...addFiles, ...liquidateFiles]);
    for (const file of files) {
      const { cid } = file;
      if (this.isFileIncluded(file)) {
        this.addFiles.delete(cid);
        continue;
      }
      if (this.isFileFulled(file)) {
        this.enqueueDelFile(cid);
        continue;
      }
    }
    this.reportFiles = [[], []];
  }

  private dequeueTea(): QueueItem {
    let maxScore = 0;
    let queueIndex = 0;
    this.teaQueue.forEach((item, index) => {
      const { fileSize } = item;
      const timeEstimate = srvs.teaclave.estimateTime(fileSize, true);
      const score = this.calculateScore(item, timeEstimate);
      if (score > maxScore) {
        queueIndex = index;
        maxScore = score;
      }
    });
    return this.teaQueue.splice(queueIndex, 1)[0];
  }

  private isFileFulled(file: ChainFile) {
    return file.numReplicas >= srvs.chain.constants.maxFileReplicas;
  }

  private isFileIncluded(file: ChainFile) {
    if (file.included) {
      this.onchainFiles.set(file.cid, file.expireAt);
      return true;
    }
    return false;
  }

  private isFileLiquidated(file: ChainFile) {
    return file.expireAt > srvs.chain.latestBlockNum - 1;
  }

  private calculateScore(item: QueueItem, timeEstimate: number) {
    const {
      blockSecs,
      sessionDuration,
      latestBlockNum,
      planReportAt,
      maxFileReplicas,
    } = srvs.chain.commonProps();
    const { numReplicas } = item;
    const timeBlocks =
      Math.ceil(timeEstimate / blockSecs / 1000) % sessionDuration;
    let reportBlocks: number;
    if (timeBlocks + latestBlockNum <= planReportAt) {
      reportBlocks = planReportAt - latestBlockNum - timeBlocks;
    } else {
      reportBlocks =
        planReportAt + sessionDuration - latestBlockNum - timeBlocks;
    }
    const blockScore = Math.max(30 - reportBlocks, 0) * 1000;
    const replicaScore = Math.max(maxFileReplicas - numReplicas, 0) * 100;
    return blockScore + replicaScore;
  }
}

export const init = createInitFn(Service);

interface QueueItem {
  cid: string;
  fileSize: number;
  numReplicas: number;
}
