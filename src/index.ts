import Chain, { Peroid } from "./chain";
import makeIpfs, { Ipfs } from "./ipfs";
import Teaclave from "./teaclave";
import Store from "./store";
import emitter from "./emitter";
import { fatal, logger, sleep } from "./utils";
import { MaxPriorityQueue } from "@datastructures-js/priority-queue";

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
  private ipfsQueue: MaxPriorityQueue<Task>;
  private teaQueue: MaxPriorityQueue<Task>;
  private period = Peroid.Idle; 
  private isReporting = false;
  private reportCids: string[];

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
      if (!isTeaclaveOk) await sleep(10000);
    } while(!isTeaclaveOk);

    this.chain.listen();
    
    this.store.init(this.chain, this.ipfs, this.teaclave);
    this.runIpfsQueue();
    this.runTeaQueue();

    emitter.on("header", async header => {
      try {
        const blockNum = header.number.toNumber();
        const period = await this.chain.detectPeroid(blockNum);
        const { nextRoundAt, reportedAt }= this.chain.reportState;
        const { isReporting } = this;
        logger.debug(`blockNum=${blockNum}, period=${period}, ${JSON.stringify({ nextRoundAt, reportedAt, isReporting })}`);
        this.period = period;
        if (this.period === Peroid.Enforce) {
          if (!this.isReporting) {
            this.teaQueue.enqueue({ type: "report" }, 4);
            this.isReporting = true;
          }
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
      if (this.isReporting) {
        logger.debug(`Skip enqueue addFile ${cid}`);
        return;
      } 
      logger.debug(`IpfsQueue addFile ${cid}`);
      if (this.period === Peroid.Prepare) {
        this.ipfsQueue.enqueue({ type: "addFile", cid }, 3);
      } else if (this.period === Peroid.Idle) {
        this.ipfsQueue.enqueue({ type: "addFile", cid }, 2);
      }
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
    const maybeStash = await this.chain.getStash();
    if (maybeStash.isNone) {
      logger.warn("💥 Account is not stashed");
      return false;
    }
    const stash = maybeStash.unwrap();
    if (stash.machine_id.isNone) {
      const attest = await this.teaclave.attest();
      if (!attest) return false;
      const res = await this.chain.register(attest);
      if (res.status === "failed") {
        fatal("Fail to register node");
        return false;
      }
      logger.info("✨ Register node successed");
      return false;
    }
    const system = await this.teaclave.system();
    const machine = stash.machine_id.unwrap().toString();
    if (machine !== "0x" + system.machine_id) {
      fatal(`💥 On chain machine is ${system.machine_id}, current machind is ${machine}`);
      return false;
    }
    if (this.chain.reportState.rid && system.cursor_committed !== this.chain.reportState.rid) {
      await this.teaQueue.enqueue({ type: "commit" }, 4);
    }
    this.machine = machine;
    return true;
  }

  private async runIpfsQueue() {
    while (true) {
      if (this.ipfsQueue.isEmpty()) {
        await sleep(2000);
        continue;
      }
      const { element: task } = this.ipfsQueue.dequeue();
      if (task.type === "addFile") {
        await this.addIpfsFile(task.cid);
      }
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
      if (!file.isPinned) {
        await this.ipfs.pinAdd(cid);
        this.store.addPin(cid);
      }
      this.teaQueue.enqueue({ type: "addFile", cid }, 3);
      logger.info(`✨ AddIpfsFile ${cid} success`);
    } catch (e) {
      this.store.markFileIpfsFail(cid);
      logger.error(`💥 Fail to add ipfs file ${cid}, ${e.toString()}`);
    }
  }

  private async addTeaFile(cid) {
    try {
      logger.debug(`Execute addFile ${cid}`);
      const file = this.store.getFile(cid);
      if (!file) {
        logger.warn(`File ${cid} must exist when addFile`);
        return;
      }
      if (!file.isAdded) {
        const res = await this.teaclave.addFile(cid);
        if (res) this.store.addTeaFile({ cid, fileSize: res.size, committed: false });
      }
      logger.info(`✨ AddFile ${cid} success`);
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
    this.isReporting = false;
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
      const pendingFiles = await this.store.getPendingFiles();
      logger.debug(`Get pendding files ${JSON.stringify(pendingFiles)}`);
      for (const cid of pendingFiles.ipfsFiles) {
        this.ipfsQueue.enqueue({ type: "addFile", cid }, 2);
      }
      for (const cid of pendingFiles.teaFiles) {
        this.teaQueue.enqueue({ type: "addFile", cid }, 3);
      }
    } catch {}
  }

}

const engine = new Engine();
engine.init().catch(e => {
  logger.error(`💥 Caught on engine.init: ${e.toString()}`);
  process.exit(1);
});
