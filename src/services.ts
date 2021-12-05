import useServices from "use-services";
import { EventEmitter } from "events";
import * as Winston from "@use-services/winston";
import * as Echo from "@use-services/echo";
import * as Chain from "./chain";
import * as Ipfs from "./ipfs";
import * as Teaclave from "./teaclave";
import * as Engine from "./engine";

const settings = {
  app: "worker",
};

const options = {
  logger: {
    init: Winston.init,
    args: {
      console: {
        level: process.env.WORKER__LOG__LEVEL || "info",
      },
    },
  } as Winston.Option<Winston.Service>,
  settings: {
    init: Echo.init,
    args: settings,
  } as Echo.Option<typeof settings>,
  chain: {
    init: Chain.init,
    args: {
      url: "ws://127.0.0.1:9944",
      secret: process.env.WORKER__MNEMONIC || "//Alice",
      blockSecs: 6,
      reportBlocks: 10,
    },
  } as Chain.Option<Chain.Service>,
  ipfs: {
    init: Ipfs.init,
    args: {
      url: "http://127.0.0.1:5001",
    },
  } as Ipfs.Option<Ipfs.Service>,
  teaclave: {
    init: Teaclave.init,
    args: {
      baseURL: "http://127.0.0.1:2121",
      headers: {
        "Content-Type": "application/json",
      },
    },
  } as Teaclave.Option<Teaclave.Service>,
  engine: {
    init: Engine.init,
    args: {
      iterFilesPageSize: 100,
    },
  } as Engine.Option<Engine.Service>,
};

const { srvs, init, emitter: emitter_ } = useServices(settings.app, options);
const emitter = emitter_ as EventEmitter;

export { srvs, init, emitter };