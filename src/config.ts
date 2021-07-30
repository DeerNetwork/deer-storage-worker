import { readEnv } from "read-env";
import * as _ from "lodash";

const config =  {
  blockSecs: 6,
  mnemonic: "//Alice",
  logLevel: "info",
  chain: {
    endpoint: "ws://127.0.0.1:9944",
  },
  ipfs: {
    url: "http://127.0.0.1:5001",
    pinTimeout: 3000,
  },
  teaclave: {
    baseURL: "http://127.0.0.1:2121",
    timeout: 10000,
    headers: {
      "Content-Type": "application/json",
    },
  },
};

_.merge(config, readEnv("WORKER"));

export default config;
