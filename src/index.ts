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
  public async init() {
    this.chain = new Chain();
    this.ipfs = makeIpfs();
    this.teaclave = new Teaclave();
    this.queue = new MaxPriorityQueue();
    await this.chain.init()
    await this.initEnclave();
    await this.chain.listen();
    await this.runQueue();

    emitter.on("header", async header => {
      try {
        const period = this.chain.detectPeroid(header.number.toNumber());
        this.period = period;
        if (this.period === Peroid.Enforce) {
          this.queue.enqueue({ type: "report" }, 4);
        }
      } catch (e) {
        logger.error(`💥 Caught on event header: ${e.toString()}`)
      }
    });
    emitter.on("file:add", cid => {
      if (this.period === Peroid.Prepare) {
        this.queue.enqueue({ type: "addFile", cid }, 3);
      } else if (this.period === Peroid.Idle) {
        this.queue.enqueue({ type: "addFile", cid }, 2);
      }
    });
    emitter.on("file:del", async cid => {
      this.queue.enqueue({ type: "delFile", cid }, 1);
    });
  }

  private async initEnclave() {
    const maybeStash = await this.chain.getStash();
    if (maybeStash.isNone) {
      fatal("Account is not stashed");
    }
    const stash = maybeStash.unwrap();
    if (stash.machine_id.isNone) {
      const attest = await this.teaclave.attest();
      logger.info(`💸 Registering node with ${JSON.stringify(attest)}`);
      const res = await this.chain.register(attest);
      if (res.status === "failed") {
        fatal("💥 Fail to register node")
      }
      logger.info("✨ Register node successed");
    } else {
      const system = await this.teaclave.system();
      const machine = stash.machine_id.unwrap().toString();
      if (machine !== system.machine_id) {
        fatal(`💥 On chain machine is ${system.machine_id}, current machind is ${machine}`);
      }
      this.machine = machine;
    }
  }

  private async runQueue() {
    while (true) {
      if (this.queue.isEmpty()) {
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
  }

  private async addFile(cid) {
    try {
      const fileState = await this.chain.getFileState(cid);
      if (fileState.included) return;
      await this.ipfs.pin(cid)
      await this.teaclave.addFile(cid);
      this.files.push(cid);
    } catch (e) {
      logger.error(`💥 Fail to add file ${cid}, ${e.toString()}`)
    }
  }

  private async delFile(cid) {
    try {
      await this.teaclave.delFile(cid);
      await this.ipfs.unpin(cid)
    } catch (e) {
      logger.error(`💥 Fail to del file ${cid}, ${e.toString()}`)
    }
  }

  private async report() {
    try {
      const fileStates = await Promise.all(this.files.map(async cid => {
        return this.chain.getFileState(cid);
      }));
      const toAddFiles = [];
      const toDelFiles = [];
      for (const state of fileStates) {
        if (!state.included && state.numReplicas < this.chain.constants.maxFileReplicas) {
          toAddFiles.push(state.cid);
        } else {
          toDelFiles.push(state.cid);
        }
      }
      const settleFiles = [];
      const reportData = await this.teaclave.preparePeport(toAddFiles);
      const res = await this.chain.prepareReport(this.machine, reportData, settleFiles);
      if (res.status === "failed") {
        fatal("💥 Fail to report work")
      }
      logger.info("✨ Report node successed");
      await this.teaclave.commitReport(reportData.rid);
      await this.chain.syncReportState();
      toDelFiles.forEach(cid => {
        this.queue.enqueue({ type: "delFile", cid }, 1);
      })
    } catch (e) {
      logger.error(`💥 Fail to report ${e.toString()}`);
    }
  }

}

const engine = new Engine();
engine.init().catch(e => {
    logger.error(`💥 Caught on engine.init: ${e.toString()}`)
});