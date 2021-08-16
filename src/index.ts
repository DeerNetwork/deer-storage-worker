import Chain from "./chain";
import makeIpfs, { Ipfs } from "./ipfs";
import Teaclave from "./teaclave";
import Store from "./store";
import emitter from "./emitter";
import config from "./config";
import { fatal, logger, sleep } from "./utils";
import { MaxPriorityQueue, MinPriorityQueue } from "@datastructures-js/priority-queue";

interface Task {
  type: "addFile" | "delFile" | "report" | "commit",
  cid?: string,
}

class Engine {
  private chain: Chain;
  private ipfs: Ipfs;
  private teaclave: Teaclave;
  private store: Store;
  private machine: string;
  private ipfsQueue: MinPriorityQueue<string>;
  private teaQueue: MaxPriorityQueue<Task>;
  private startingReportAt = 0;
  private reportCids: string[];
  private checkPoint = 0;
  private ipfsConcurrency = config.ipfs.concurrency;

  public async init() {
    this.chain = new Chain();
    this.ipfs = makeIpfs();
    this.teaclave = new Teaclave();
    this.ipfsQueue = new MaxPriorityQueue();
    this.teaQueue = new MaxPriorityQueue();
    this.store = new Store();
    await this.chain.init();
    let isTeaclaveOk = false;
    do {
      isTeaclaveOk = await this.initTeaclave();
      if (!isTeaclaveOk) await sleep(3 * config.blockSecs * 1000);
    } while(!isTeaclaveOk);

    this.chain.listen();
    this.checkPoint = this.chain.now;
    this.store.init(this.chain, this.ipfs, this.teaclave);
    this.runIpfsQueue();
    this.runTeaQueue();
    setInterval(() => {
      this.checkInterval();
    }, 60000);

    emitter.on("header", async header => {
      try {
        const blockNum = header.number.toNumber();
        const sholdReport = await this.chain.shouldReport(blockNum);
        const { nextReportAt, reportedAt, nextRoundAt } = this.chain.reportState;
        logger.debug(`blockNum=${blockNum}, ${JSON.stringify({ reportedAt, nextReportAt, nextRoundAt })}`);
        if (sholdReport) {
          if (this.startingReportAt > 0) {
            if (blockNum - this.startingReportAt > 60) {
              this.startingReportAt = 0;
            }
          } else {
            this.startingReportAt = blockNum;
            this.teaQueue.enqueue({ type: "report" }, 4);
          }
        }
        if (blockNum % 60 === 0) {
          this.checkPending();
        }
      } catch (e) {
        logger.error(`💥 Caught on event header: ${e.toString()}`);
      }
    });
    emitter.on("file:add", async cid => {
      const [maybeFileOrder, maybeStoreFile] = await Promise.all([
        this.chain.getStoreFie(cid),
        this.chain.getFileOrder(cid),
      ]);
      if (maybeStoreFile.isSome) {
        this.store.addStoreFile(cid, maybeFileOrder.unwrap());
      }
      if (maybeFileOrder.isSome) {
        this.store.addStoreFile(cid, maybeFileOrder.unwrap());
      }
      if (this.startingReportAt) {
        logger.debug(`Skip enqueue addFile ${cid}`);
        return;
      } 
      logger.debug(`IpfsQueue addFile ${cid}`);
      this.ipfsQueue.enqueue(cid, this.chain.getReportInterval());
    });
    emitter.on("file:del", async cid => {
      logger.debug(`TeaQueue delFile ${cid}`);
      this.teaQueue.enqueue({ type: "delFile", cid }, 1);
    });
    emitter.on("reported", async () => {
      logger.debug("TeaQueue commit");
      this.teaQueue.enqueue({ type: "commit" }, 4);
    });
  }

  private async initTeaclave() {
    try {
      const maybeStash = await this.chain.getStash();
      if (maybeStash.isNone) {
        logger.warn("💥 Account is not stashed");
        return false;
      }
      const stash = maybeStash.unwrap();
      if (stash.machine_id.isNone) {
        await this.registerTeaclave();
        return false;
      }
      const system = await this.teaclave.system();
      const machine = stash.machine_id.unwrap().toString();
      if (machine !== "0x" + system.machine_id) {
        fatal(`💥 On chain machine is ${system.machine_id}, current machind is ${machine}`);
        return false;
      }
      if (!system.enclave) {
        await this.registerTeaclave();
        return false;
      }
      const maybeRegister = await this.chain.getRegister(machine);
      if (maybeRegister.isNone) {
        await this.registerTeaclave();
        return false;
      }
      if (maybeRegister.unwrap().enclave.toHex() !== "0x" + system.enclave) {
        await this.registerTeaclave();
        return false;
      }
      if (this.chain.reportState.rid && system.cursor_committed !== this.chain.reportState.rid) {
        await this.teaQueue.enqueue({ type: "commit" }, 4);
      }
      this.machine = machine;
      return true;
    } catch (err) {
      if (/teaclave.attest: connect ECONNREFUSED/.test(err.message)) {
        logger.warn("💥 Waiting for teaclave ready");
        return false;
      }
      logger.error(`💥 Fail to init teaclave, ${err.toString()}`);
      return false;
    }
  }

  private async registerTeaclave() {
    const attest = await this.teaclave.attest();
    if (!attest) return;
    const res = await this.chain.register(attest);
    if (res.status === "failed") {
      fatal("Fail to register node");
      return;
    }
    logger.info("✨ Register node successed");
  }

  private async runIpfsQueue() {
    while (true) {
      if (this.ipfsQueue.isEmpty() || this.ipfsConcurrency <= 0) {
        await sleep(2000);
        continue;
      }
      const { element: cid } = this.ipfsQueue.dequeue();
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
      const { element: task } = this.teaQueue.dequeue();
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
      logger.debug(`Execute addIpfsFile ${cid}`);
      const file = this.store.getFile(cid);
      if (!file) {
        logger.warn(`File ${cid} must exist when addIpfsFile`);
        return;
      }
      // TODO check disk space
      if (!file.isPinned) {
        const ipfsFileSize = await this.ipfs.size(cid);
        if (ipfsFileSize > this.chain.constants.maxFileSize) {
          throw new Error("fileSize too large");
        }
        await this.ipfs.pinAdd(cid, file.fileSize);
        this.store.addPin(cid);
      }
      this.teaQueue.enqueue({ type: "addFile", cid }, 3);
      logger.info(`✨ AddIpfsFile ${cid} success`);
    } catch (e) {
      this.store.markFileIpfsFail(cid);
      logger.error(`💥 Fail to add ipfs file ${cid}, ${e.toString()}`);
    }
    this.ipfsConcurrency -= 1;
  }

  private async addTeaFile(cid) {
    try {
      logger.debug(`Execute addTeaFile ${cid}`);
      const file = this.store.getFile(cid);
      if (!file) {
        logger.warn(`File ${cid} must exist when addTeaFile`);
        return;
      }
      if (!file.isAdded) {
        const res = await this.teaclave.addFile(cid);
        if (res) this.store.addTeaFile({ cid, fileSize: res.size, committed: false });
      }
      logger.info(`✨ addTeaFile ${cid} success`);
    } catch (e) {
      logger.error(`💥 Fail to add file ${cid}, ${e.toString()}`);
    }
  }

  private async delFile(cid) {
    try {
      logger.debug(`Execute delFile ${cid}`);
      await this.store.checkDeleteCid(cid);
      await this.store.deleteDirtyFile(cid);
    } catch (e) {
      logger.error(`💥 Fail to del file ${cid}, ${e.toString()}`);
    }
  }


  private async report() {
    try {
      logger.debug("Worker trying to report works");
      const { reported } = await this.chain.getReportState();
      if (reported) return;
      const { addFiles, settleFiles } =  await this.store.getReportFiles();
      const reportData = await this.teaclave.preparePeport(addFiles);
      const res = await this.chain.reportWork(this.machine, reportData, settleFiles);
      if (res.status === "failed") {
        fatal("Fail to report work");
      }
      this.reportCids = [...addFiles, ...settleFiles];
      logger.info("✨ Report node successed");
    } catch (e) {
      logger.error(`💥 Fail to report ${e.toString()}`);
    } 
    this.startingReportAt = 0;
  }

  private async commit() {
    try {
      logger.debug("Worker trying to commit report");
      await this.chain.getReportState();
      await this.teaclave.commitReport(this.chain.reportState.rid);
      this.afterCommit();
      logger.info("✨ Commit report successed");
    } catch (e) {
      logger.error(`💥 Fail to commit report ${e.toString()}`);
    }
  }

  private async afterCommit() {
    try {
      await this.store.checkReportCids(this.reportCids);
    } catch {}
  }
  
  private async checkInterval() {
    try {
      if (this.chain.now === this.checkPoint) {
        await this.chain.init();
      }
    } catch {}
    this.checkPoint = this.chain.now;
  }

  private async checkPending() {
    try {
      const myFiles = await this.store.getPendingFiles();
      logger.debug(`Get pendding files ${JSON.stringify(myFiles)}`);
      for (const cid of myFiles.ipfsFiles) {
        this.ipfsQueue.enqueue(cid, this.chain.constants.roundDuration);
      }
      for (const cid of myFiles.teaFiles) {
        this.teaQueue.enqueue({ type: "addFile", cid }, 3);
      }
    } catch {}
  }
}

const engine = new Engine();
engine.init().catch(err => {
  logger.error(`💥 Caught on engine.init: ${err.toString()}`);
  process.exit(1);
});
