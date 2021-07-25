import * as path from "path";
import * as _ from "lodash";

const config =  {
  blockSecs: 6,
  secret: "//Alice",
  log: {
    level: "info",
    dir: process.cwd(),
    console: true,
  },
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

try {
  const localConfig = require("./config.json");
  _.merge(config, localConfig);
} catch {
  try {
    const localConfig = require(path.resolve(__dirname, "../config.json"));
    _.merge(config, localConfig);
  } catch {}
}

export default config;
