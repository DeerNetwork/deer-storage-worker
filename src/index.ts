import Chain, { Peroid } from "./chain";
import makeIpfs, { Ipfs } from "./ipfs";
import Teaclave from "./teaclave";
import emitter from "./emitter";
import { fatal, logger, sleep } from "./utils";
import { MaxPriorityQueue } from "@datastructures-js/priority-queue";

type Task = AddFileTask | DelFileTask | ReportTask;

interface AddFileTask {
  type: "addFile",
  cid: string;
}

interface DelFileTask {
  type: "delFile",
  cid: string,
}

interface ReportTask {
  type: "report",
}

class Engine {
  private chain: Chain;
  private ipfs: Ipfs;
  private teaclave: Teaclave;
  private machine: string;
  private queue: MaxPriorityQueue<Task>;
  private period = Peroid.Idle; 
  private files: string[] = [];
  private isReporting = false;

  public async init() {
    this.chain = new Chain();
    this.ipfs = makeIpfs();
    this.teaclave = new Teaclave();
    this.queue = new MaxPriorityQueue();
    await this.chain.init();
    let isTeaclaveOk = false;
    do {
      isTeaclaveOk = await this.initTeaclave();
      if (!isTeaclaveOk) await sleep(10000);
    } while(!isTeaclaveOk);

    this.chain.listen();
    this.runQueue();

    emitter.on("header", async header => {
      try {
        const period = this.chain.detectPeroid(header.number.toNumber());
        this.period = period;
        if (this.period === Peroid.Enforce) {
          if (!this.isReporting) {
            this.queue.enqueue({ type: "report" }, 4);
            this.isReporting = true;
          }
        }
      } catch (e) {
        logger.error(`💥 Caught on event header: ${e.toString()}`);
      }
    });
    emitter.on("file:add", cid => {
      if (this.isReporting) {
        logger.debug(`Skip enqueue addFile(${cid})`);
        return;
      } else {
        logger.debug(`Enqueue addFile(${cid})`);
      }
      if (this.period === Peroid.Prepare) {
        this.queue.enqueue({ type: "addFile", cid }, 3);
      } else if (this.period === Peroid.Idle) {
        this.queue.enqueue({ type: "addFile", cid }, 2);
      }
    });
    emitter.on("file:del", async cid => {
      logger.debug(`Enqueue delFile(${cid})`);
      this.queue.enqueue({ type: "delFile", cid }, 1);
    });
    emitter.on("reported", async () => {
      logger.debug("Node reported works.");
      this.commitReport();
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
    this.machine = machine;
    return true;
  }

  private async runQueue() {
    while (this.queue.isEmpty()) {
      await sleep(2000);
    }
    const { element: task } = this.queue.dequeue();
    if (task.type === "addFile") {
      await this.addFile(task.cid);
    } else if (task.type === "delFile") {
      await this.delFile(task.cid);
    } else if (task.type === "report") {
      await this.report();
    }
  }

  private async addFile(cid) {
    try {
      logger.debug(`Execute addFile ${cid}`);
      const fileState = await this.chain.getFileState(cid);
      if (fileState.included) return;
      await this.ipfs.pin(cid);
      await this.teaclave.addFile(cid);
      this.files.push(cid);
      logger.info(`✨ AddFile ${cid} success`);
    } catch (e) {
      logger.error(`💥 Fail to add file ${cid}, ${e.toString()}`);
    }
  }

  private async delFile(cid) {
    try {
      logger.debug(`Execute delFile ${cid}`);
      await this.teaclave.delFile(cid);
      await this.ipfs.unpin(cid);
      logger.info(`✨ DelFile ${cid} success`);
    } catch (e) {
      logger.error(`💥 Fail to del file ${cid}, ${e.toString()}`);
    }
  }

  private async report() {
    try {
      logger.debug("Worker trying to report works");
      const fileStates = await Promise.all(this.files.map(async cid => {
        return this.chain.getFileState(cid);
      }));
      const toAddFiles = [];
      for (const state of fileStates) {
        if (!state.included && state.numReplicas < this.chain.constants.maxFileReplicas) {
          toAddFiles.push(state.cid);
        }
      }
      const settleFiles = [];
      const reportData = await this.teaclave.preparePeport(toAddFiles);
      const res = await this.chain.reportWork(this.machine, reportData, settleFiles);
      if (res.status === "failed") {
        fatal("Fail to report work");
      }
      logger.info("✨ Report node successed");
    } catch (e) {
      logger.error(`💥 Fail to report ${e.toString()}`);
    } finally {
      this.files = [];
      this.isReporting = false;
    }
  }

  private async commitReport() {
    try {
      logger.debug("Worker trying to commit report");
      await this.chain.getReportState();
      await this.teaclave.commitReport(this.chain.reportState.rid);
      logger.info("✨ Commit report successed");
    } catch (e) {
      logger.error(`💥 Fail to commit report ${e.toString()}`);
    }
  }
}

const engine = new Engine();
engine.init().catch(e => {
  logger.error(`💥 Caught on engine.init: ${e.toString()}`);
  process.exit(1);
});
