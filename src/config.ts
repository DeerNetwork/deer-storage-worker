import { readEnv } from "read-env";
import * as _ from "lodash";

const config =  {
  blockSecs: 6,
  mnemonic: "//Alice",
  log_level: "info",
  chain: {
    endpoint: "ws://loclahost:9494",
  },
  ipfs: {
    url: "http://localhost:5001",
    pinTimeout: 3000,
  },
  teaclave: {
    baseURL: "http://localhost:2121",
    timeout: 3000,
    headers: {
      "Content-Type": "application/json",
    },
  },
};

_.merge(config, readEnv("WORKER"));

export default config;
