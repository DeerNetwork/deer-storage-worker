import {
  ServiceOption,
  createInitFn,
  InitOption,
  STOP_KEY,
} from "use-services";
import _ from "lodash";
import { srvs, emitter } from "./services";
import { sleep } from "./utils";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  iterFilesPageSize: number;
}

const WHILE_SLEEP = 2000;
const CHECK_HEALTH_SLEEP = 180000;

export class Service {
  private args: Args;
  private machine: string;
  private iterKey: string;
  private ipfsQueue: QueueItem[] = [];
  private teaQueue: QueueItem[] = [];
  private delQueue: string[] = [];
  private checkQueue: string[] = [];
  private addFiles: string[] = [];
  private settleFiles: string[] = [];
  private destoryed = false;

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
    this.runCheckQueue();
    this.checkHealth();
    this.iterChainFiles();
    this.iterTeaFiles();
  }

  public async reportWork() {
    try {
      await this.commitReport();
      const { maxReportFiles } = srvs.chain.constants;
      const addFiles = this.addFiles.slice();
      const settleFiles = this.settleFiles.slice();
      const currentAddFiles = addFiles.splice(0, maxReportFiles);
      const currentSettleFiles = settleFiles.splice(0, maxReportFiles);
      const reportData = await srvs.teaclave.preparePeport(currentAddFiles);
      await srvs.chain.reportWork(this.machine, reportData, currentSettleFiles);
      this.addFiles = addFiles;
      this.settleFiles = settleFiles;
      currentAddFiles.forEach((cid) => {
        if (!this.checkQueue.find((v) => v === cid)) this.checkQueue.push(cid);
      });
      srvs.logger.info("Report works successed");
    } catch (err) {
      srvs.logger.error(`Fail to report works, ${err.message}`);
    }
  }

  public async commitReport() {
    const { rid } = srvs.chain.reportState;
    const system = await srvs.teaclave.system();
    if (system.cursor_committed < rid) {
      await srvs.teaclave.commitReport(rid);
    }
  }

  public async enqueueAddFile(cid: string) {
    try {
      const file = await this.worthAddFile(cid);
      if (!file) return;
      this.ipfsQueue.push({
        cid,
        fileSize: file.fileSize,
        numReplicas: file.numReplicas,
      });
    } catch (err) {
      srvs.logger.error(`Fail to add file ${cid}, ${err.message}`);
    }
  }

  public async enqueueDelFile(cid: string) {
    this.ipfsQueue = this.ipfsQueue.filter((v) => v.cid !== cid);
    this.teaQueue = this.teaQueue.filter((v) => v.cid !== cid);
    this.addFiles = this.addFiles.filter((v) => v !== cid);
    this.settleFiles = this.settleFiles.filter((v) => v !== cid);
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
      const maybeStash = await srvs.chain.getStash();
      if (maybeStash.isNone) {
        srvs.logger.warn("Account have not been stashed");
        return false;
      }
      const stash = maybeStash.unwrap();
      if (stash.machineId.isNone) {
        srvs.logger.info("Try to register teaclave");
        await this.registerNode();
        return false;
      }
      const system = await srvs.teaclave.system();
      const machine = stash.machineId.unwrap().toString();
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
      srvs.logger.info("Fail to fetch attest");
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
    while (true) {
      if (this.destoryed) break;
      if (this.ipfsQueue.length === 0 || !srvs.ipfs.health) {
        await sleep(WHILE_SLEEP);
        continue;
      }
      const { maxReportFiles } = srvs.chain.constants;
      if (this.addFiles.length >= maxReportFiles) {
        await sleep(WHILE_SLEEP);
        continue;
      }
      const item = this.dequeueIpfs();
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
      const item = this.dequeueTea();
      await this.addTeaFile(item);
    }
  }

  private async runDelQueue() {
    while (true) {
      if (this.destoryed) break;
      if (
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

  private async runCheckQueue() {
    while (true) {
      if (this.destoryed) break;
      if (
        this.delQueue.length === 0 ||
        !srvs.ipfs.health ||
        !srvs.teaclave.health
      ) {
        await sleep(WHILE_SLEEP * 3);
        continue;
      }
      const cid = this.checkQueue.shift();
      try {
        const teaFile = await srvs.teaclave.getFile(cid);
        if (!teaFile) continue;
        const file = await this.worthAddFile(cid);
        if (!file) {
          this.enqueueDelFile(cid);
          continue;
        }
        if (teaFile.committed) {
          if (!this.addFiles.find((v) => v === cid)) this.addFiles.push(cid);
        }
        this.checkQueue.push(cid);
        continue;
      } catch {}
    }
  }

  private async addIpfsFile(item: QueueItem) {
    const { cid, fileSize } = item;
    try {
      const file = await this.worthAddFile(cid);
      if (!file) return;
      await srvs.ipfs.pinAdd(cid, fileSize);
      this.teaQueue.push(item);
    } catch (err) {
      srvs.logger.error(`Fail to add ipfs file ${cid}, ${err.message}`);
    }
  }

  private async addTeaFile(item: QueueItem) {
    const { cid, fileSize } = item;
    try {
      await srvs.teaclave.addFile(cid, fileSize);
      if (!this.addFiles.find((v) => v === cid)) this.addFiles.push(cid);
    } catch (err) {
      srvs.logger.error(`Fail to add tea file ${cid}, ${err.message}`);
    }
  }

  private async delFile(cid: string) {
    try {
      const file = await srvs.chain.getFile(cid);
      if (file && file.existReplica) return;
      await srvs.ipfs.pinRemove(cid);
      await srvs.teaclave.delFile(cid);
    } catch (err) {
      srvs.logger.error(`Fail to del file ${cid}, ${err.message}`);
    }
  }

  private async iterChainFiles() {
    try {
      const keys = await srvs.chain.iterStoreFileKeys(
        this.args.iterFilesPageSize,
        this.iterKey
      );
      for (const key of keys) {
        const cid = key.toHuman()[0];
        await this.enqueueAddFile(cid);
      }
      if (keys.length > 0) this.iterKey = _.last(keys).toString();
    } catch (err) {
      srvs.logger.error(`Fail to iter chain files, ${err.message}`);
    }
  }

  private async iterTeaFiles() {
    try {
      const teaFiles = await srvs.teaclave.listFiles();
      for (const teaFile of teaFiles) {
        const { cid } = teaFile;
        if (!this.checkQueue.find((v) => v === cid)) this.checkQueue.push(cid);
      }
    } catch (err) {
      srvs.logger.error(`Fail to iter tea files, ${err.message}`);
    }
  }

  private async worthAddFile(cid: string) {
    const file = await srvs.chain.getFile(cid);
    if (!file) return;
    const { maxFileReplicas } = srvs.chain.constants;
    if (file.numReplicas >= maxFileReplicas && !file.existReplica) return;
    if (
      file.reserved === "0" &&
      file.expireAt >= srvs.chain.latestBlockNum &&
      file.existReplica
    ) {
      if (!this.settleFiles.find((v) => v === cid)) this.settleFiles.push(cid);
      return;
    }
    if (!(await srvs.ipfs.existProv(cid))) {
      srvs.logger.warn(`Invalid file ${cid}`);
      return;
    }
    return file;
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

  private dequeueIpfs(): QueueItem {
    let maxScore = 0;
    let queueIndex = 0;
    this.ipfsQueue.forEach((item, index) => {
      const { fileSize } = item;
      const timeEstimate =
        srvs.ipfs.estimateTime(fileSize, true) +
        srvs.teaclave.estimateTime(fileSize, true);
      const score = this.calculateScore(item, timeEstimate);
      if (score > maxScore) {
        queueIndex = index;
        maxScore = score;
      }
    });
    return this.ipfsQueue.splice(queueIndex, 1)[0];
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

  private calculateScore(item: QueueItem, timeEstimate: number) {
    const {
      blockSecs,
      roundDuration,
      latestBlockNum,
      planReportAt,
      maxFileReplicas,
    } = srvs.chain.commonProps();
    const { numReplicas } = item;
    const timeBlocks =
      Math.ceil(timeEstimate / blockSecs / 1000) % roundDuration;
    let reportBlocks: number;
    if (timeBlocks + latestBlockNum <= planReportAt) {
      reportBlocks = planReportAt - latestBlockNum - timeBlocks;
    } else {
      reportBlocks = planReportAt + roundDuration - latestBlockNum - timeBlocks;
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