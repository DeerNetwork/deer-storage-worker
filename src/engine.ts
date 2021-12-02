import { ServiceOption, InitOption, createInitFn } from "use-services";
import { srvs, emitter } from "./services";
import { sleep } from "./utils";
import {
  MaxPriorityQueue,
  MinPriorityQueue,
  PriorityQueueItem,
} from "@datastructures-js/priority-queue";
import { Task } from "./types";

export type Option<S extends Service> = ServiceOption<Args, S>;

export interface Args {
  concurrency: number;
}

export class Service {
  private args: Args;
  private machine: string;
  private ipfsQueue: MinPriorityQueue<string>;
  private teaQueue: MaxPriorityQueue<Task>;
  private startingReportAt = 0;
  private reportCids: string[];
  private ipfsConcurrency = 0;
  public constructor(option: InitOption<Args, Service>) {
    this.args = option.args;
    this.ipfsConcurrency = this.args.concurrency;
  }

  public async run() {
    this.ipfsQueue = new MaxPriorityQueue();
    this.teaQueue = new MaxPriorityQueue();
    let isTeaclaveOk = false;
    do {
      isTeaclaveOk = await this.initTeaclave();
      if (!isTeaclaveOk) await sleep(3 * srvs.chain.blockSecs * 1000);
    } while (!isTeaclaveOk);

    srvs.store.run();
    this.runIpfsQueue();
    this.runTeaQueue();

    emitter.on("header", async () => {
      try {
        const { shouldReport, latestBlockNum } = srvs.chain;
        if (shouldReport) {
          if (this.startingReportAt > 0) {
            if (latestBlockNum - this.startingReportAt > 60) {
              this.startingReportAt = 0;
            }
          } else {
            this.startingReportAt = latestBlockNum;
            this.teaQueue.enqueue({ type: "report" }, 4);
          }
        }
        if (latestBlockNum % 60 === 0) {
          this.checkPending();
        }
      } catch (e) {
        srvs.logger.error(`Caught on event header, ${e.toString()}`);
      }
    });
    emitter.on("file:add", async (cid) => {
      const [maybeFileOrder, maybeStoreFile] = await Promise.all([
        srvs.chain.getStoreFie(cid),
        srvs.chain.getFileOrder(cid),
      ]);
      if (maybeStoreFile.isSome) {
        srvs.store.addStoreFile(cid, maybeFileOrder.unwrap());
      }
      if (maybeFileOrder.isSome) {
        srvs.store.addStoreFile(cid, maybeFileOrder.unwrap());
      }
      if (this.startingReportAt) {
        srvs.logger.debug(`Skip enqueue addFile ${cid}`);
        return;
      }
      srvs.logger.debug(`IpfsQueue addFile ${cid}`);
      this.ipfsQueue.enqueue(cid, srvs.chain.numBlocksBeforeReport());
    });
    emitter.on("file:del", async (cid) => {
      srvs.logger.debug(`TeaQueue delFile ${cid}`);
      this.teaQueue.enqueue({ type: "delFile", cid }, 1);
    });
    emitter.on("reported", async () => {
      srvs.logger.debug("TeaQueue commit");
      this.teaQueue.enqueue({ type: "commit" }, 4);
    });
  }

  private async initTeaclave() {
    try {
      const maybeStash = await srvs.chain.getStash();
      if (maybeStash.isNone) {
        srvs.logger.warn("Account have not been stashed");
        return false;
      }
      const stash = maybeStash.unwrap();
      if (stash.machineId.isNone) {
        await this.registerTeaclave();
        return false;
      }
      const system = await srvs.teaclave.system();
      const machine = stash.machineId.unwrap().toString();
      if (machine !== "0x" + system.machine_id) {
        emitter.emit(
          "fatal",
          `Differect machin detected, onchain expect ${system.machine_id}, current ${machine}`
        );
        return false;
      }
      if (!system.enclave) {
        await this.registerTeaclave();
        return false;
      }
      const maybeRegister = await srvs.chain.getRegister(machine);
      if (maybeRegister.isNone) {
        await this.registerTeaclave();
        return false;
      }
      if (maybeRegister.unwrap().enclave.toHex() !== "0x" + system.enclave) {
        await this.registerTeaclave();
        return false;
      }
      if (
        srvs.chain.reportState.rid &&
        system.cursor_committed !== srvs.chain.reportState.rid
      ) {
        await this.teaQueue.enqueue({ type: "commit" }, 4);
      }
      this.machine = machine;
      return true;
    } catch (err) {
      if (/teaclave.attest: connect ECONNREFUSED/.test(err.message)) {
        srvs.logger.warn("Waiting for teaclave ready");
        return false;
      }
      if (
        /Invalid Transaction: Transaction has a bad signature/.test(err.message)
      ) {
        emitter.emit("fatal", "Fail to call tx");
        return false;
      }
      srvs.logger.error(`Fail to init teaclave, ${err.toString()}`);
      return false;
    }
  }

  private async registerTeaclave() {
    const attest = await srvs.teaclave.attest();
    if (!attest) return;
    try {
      await srvs.chain.register(attest);
    } catch (err) {
      srvs.logger.error(`Fail to register node, ${err.message}`);
      return;
    }
    srvs.logger.info("Register node successful");
  }

  private async runIpfsQueue() {
    while (true) {
      if (this.ipfsQueue.isEmpty() || this.ipfsConcurrency <= 0) {
        await sleep(2000);
        continue;
      }
      const { element: cid } =
        this.ipfsQueue.dequeue() as PriorityQueueItem<string>;
      this.ipfsConcurrency += 1;
      await this.addIpfsFile(cid);
    }
  }

  private async runTeaQueue() {
    while (true) {
      if (this.teaQueue.isEmpty()) {
        await sleep(2000);
        continue;
      }
      const { element: task } =
        this.teaQueue.dequeue() as PriorityQueueItem<Task>;
      if (task.type === "addFile") {
        await this.addTeaFile(task.cid);
      } else if (task.type === "delFile") {
        await this.delFile(task.cid);
      } else if (task.type === "report") {
        await this.report();
      } else if (task.type === "commit") {
        await this.commit();
      }
    }
  }

  private async addIpfsFile(cid) {
    try {
      srvs.logger.debug(`Execute addIpfsFile ${cid}`);
      const file = srvs.store.getFile(cid);
      if (!file) {
        srvs.logger.warn(`File ${cid} must exist when addIpfsFile`);
        return;
      }
      // TODO check disk space
      if (!file.isPinned) {
        const ipfsFileSize = await srvs.ipfs.size(cid);
        if (ipfsFileSize > srvs.chain.constants.maxFileSize) {
          throw new Error("fileSize too large");
        }
        await srvs.ipfs.pinAdd(cid, file.fileSize);
        srvs.store.addPin(cid);
      }
      this.teaQueue.enqueue({ type: "addFile", cid }, 3);
      srvs.logger.info(`AddIpfsFile ${cid} success`);
    } catch (e) {
      srvs.store.markFileIpfsFail(cid);
      srvs.logger.error(`Fail to add ipfs file ${cid}, ${e.toString()}`);
    }
    this.ipfsConcurrency -= 1;
  }

  private async addTeaFile(cid) {
    try {
      srvs.logger.debug(`Execute addTeaFile ${cid}`);
      const file = srvs.store.getFile(cid);
      if (!file) {
        srvs.logger.warn(`File ${cid} must exist when addTeaFile`);
        return;
      }
      if (!file.isAdded) {
        const res = await srvs.teaclave.addFile(cid);
        if (res)
          srvs.store.addTeaFile({ cid, fileSize: res.size, committed: false });
      }
      srvs.logger.info(`Call addTeaFile ${cid} success`);
    } catch (e) {
      srvs.logger.error(`Fail to add file ${cid}, ${e.toString()}`);
    }
  }

  private async delFile(cid) {
    try {
      srvs.logger.debug(`Execute delFile ${cid}`);
      await srvs.store.checkDeleteCid(cid);
      await srvs.store.deleteDirtyFile(cid);
    } catch (e) {
      srvs.logger.error(`Fail to del file ${cid}, ${e.toString()}`);
    }
  }

  private async report() {
    try {
      srvs.logger.debug("Worker trying to report works");
      const { roundReported, rid } = srvs.chain.reportState;
      if (roundReported) return;
      const system = await srvs.teaclave.system();
      if (system.cursor_committed < rid) {
        srvs.logger.debug("Worker trying to commit miss report");
        await srvs.teaclave.commitReport(rid);
      }
      const { addFiles, settleFiles } = await srvs.store.getReportFiles();
      const reportData = await srvs.teaclave.preparePeport(addFiles);
      try {
        await srvs.chain.reportWork(this.machine, reportData, settleFiles);
      } catch (err) {
        srvs.logger.error(`Fail to report work, ${err.message}`);
        emitter.emit("fatal", "Fail to report work");
      }
      this.reportCids = [
        ...addFiles.slice(0, srvs.chain.constants.maxReportFiles),
        ...settleFiles.slice(0, srvs.chain.constants.maxReportFiles),
      ];
      srvs.logger.info("Report successed");
    } catch (e) {
      srvs.logger.error(`Fail to report ${e.toString()}`);
    }
    this.startingReportAt = 0;
  }

  private async commit() {
    try {
      srvs.logger.debug("Worker trying to commit report");
      const { rid } = srvs.chain.reportState;
      await srvs.teaclave.commitReport(rid);
      this.afterCommit();
      srvs.logger.info("Teaclave commit success");
    } catch (e) {
      srvs.logger.error(`Fail to commit report, ${e.toString()}`);
    }
  }

  private async afterCommit() {
    try {
      await srvs.store.checkReportCids(this.reportCids);
    } catch {}
  }

  private async checkPending() {
    try {
      const myFiles = await srvs.store.getPendingFiles();
      srvs.logger.debug(`Get pendding files ${JSON.stringify(myFiles)}`);
      for (const cid of myFiles.ipfsFiles) {
        this.ipfsQueue.enqueue(cid, srvs.chain.constants.roundDuration);
      }
      for (const cid of myFiles.teaFiles) {
        this.teaQueue.enqueue({ type: "addFile", cid }, 3);
      }
    } catch {}
  }
}

export const init = createInitFn(Service);
