const {ApiPromise, WsProvider} = require("@polkadot/api");
const {typesBundleForPolkadot} = require("@deernetwork/type-definitions");
const { Keyring  } = require("@polkadot/keyring");
const { cryptoWaitReady } = require("@polkadot/util-crypto");

async function createApi(ws) {
  return new ApiPromise({
    provider: new WsProvider(ws || "ws://localhost:9944"),
    typesBundle: typesBundleForPolkadot,
  });
}

async function createAccount(suri, type = "sr25519") {
  await cryptoWaitReady();
  const keyring = new Keyring({ type });
  return keyring.addFromUri(suri);
}

async function transfer(fromAccount, toAddress, amount) {
  return await api.tx.balances.transferKeepAlive(toAddress, amount)
    .signAndSend(fromAccount);
}

async function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  createApi,
  createAccount,
  transfer,
  sleep,
};
