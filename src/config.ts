const config =  {
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
    timeout: 3000,
  },
  teaclave: {
    baseURL: "http://localhost:2121",
    timeout: 3000,
    headers: {
      "Content-Type": "application/json",
    },
  },
};


export default config;
