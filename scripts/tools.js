const { createApi, createAccount } = require("../tmp/utils");
const { create } = require("ipfs-http-client");

function usage() {
  console.log(`
Usage:
  tools stash
  tools enclave <hex>
  tools addFile <cid>
`);
  process.exit();
}

async function createCmd() {
  const api = await createApi();
  const account = await createAccount(
    process.env.WORKER__MNEMONIC || "//Alice"
  );
  const ipfs = create("http://127.0.0.1:5001");
  return {
    async stash() {
      await api.isReady;
      const tx = await api.tx.fileStorage
        .stash(account.address)
        .signAndSend(account);
      console.log(tx.toHuman());
      process.exit();
    },
    async enclave(id) {
      await api.isReady;
      if (!id.startsWith("0x")) id = "0x" + id;
      const tx = await api.tx.sudo
        .sudo(api.tx.fileStorage.setEnclave(id, 100000))
        .signAndSend(account);
      console.log(tx.toHuman());
      process.exit();
    },
    async addFile(cid) {
      await api.isReady;
      const info = await ipfs.object.stat(cid);
      const tx = await api.tx.fileStorage
        .store(cid, info.CumulativeSize, 1e12)
        .signAndSend(account);
      console.log(tx.toHuman());
      process.exit();
    },
  };
}

const [cmd, ...args] = process.argv.slice(2);

if (!cmd) usage();
createCmd().then(async (cmds) => {
  if (!cmds[cmd]) usage();
  await cmds[cmd](...args);
});
