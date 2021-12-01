import useServices from "use-services";
import * as Winston from "@use-services/winston";
import * as Echo from "@use-services/echo";
import * as Chain from "./chain";
import * as Store from "./store";
import * as Ipfs from "./ipfs";
import * as Teaclave from "./teaclave";
import * as Engine from "./engine";
import { Emitter } from "./types";

const settings = {
  app: "worker",
};

const options = {
  logger: {
    init: Winston.init,
    args: {
      console: {
        level: "debug",
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
      secret: "//Alice",
      blockSecs: 6,
    },
  } as Chain.Option<Chain.Service>,
  store: {
    init: Store.init,
    args: {
      maxRetries: 3,
    },
  } as Store.Option<Store.Service>,
  ipfs: {
    init: Ipfs.init,
    args: {
      url: "http://127.0.0.1:5001",
      pinTimeout: 60000,
      sizeTimeout: 60000,
    },
  } as Ipfs.Option<Ipfs.Service>,
  teaclave: {
    init: Teaclave.init,
    args: {
      baseURL: "http://127.0.0.1:2121",
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
      },
    },
  } as Teaclave.Option<Teaclave.Service>,
  engine: {
    init: Engine.init,
    args: {},
  } as Engine.Option<Engine.Service>,
};

const { srvs, init, emitter: emitter_ } = useServices(settings.app, options);
const emitter = emitter_ as Emitter;

export { srvs, init, emitter };
