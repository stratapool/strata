import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, formatEther } from 'ethers';
import { loadConfig } from './config.js';
import { PoolClient } from './pool.js';
import { SerialQueue } from './queue.js';
import { createServer } from './server.js';
import { LogIndex } from './logIndex.js';
import { ProofVerifier } from './verify.js';
import { loadWallet } from './wallet.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = loadConfig();

  const provider = new JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, {
    staticNetwork: true,
  });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== cfg.CHAIN_ID) {
    throw new Error(
      `RPC reports chain ${network.chainId}, expected ${cfg.CHAIN_ID}`,
    );
  }

  const wallet = await loadWallet(cfg, provider);
  const pool = new PoolClient(cfg, provider, wallet);

  const verifier = new ProofVerifier(
    path.isAbsolute(cfg.VERIFICATION_KEY)
      ? cfg.VERIFICATION_KEY
      : path.resolve(HERE, '..', cfg.VERIFICATION_KEY),
  );
  await verifier.load();

  const [balance, denomination, fee] = await Promise.all([
    pool.balance(),
    pool.denomination(),
    pool.relayerFee(),
  ]);

  console.log(`relayer      ${wallet.address}`);
  console.log(`pool         ${cfg.POOL_ADDRESS}`);
  console.log(`chain        ${cfg.CHAIN_ID}`);
  console.log(`denomination ${formatEther(denomination)} ETH`);
  console.log(`fee/withdraw ${formatEther(fee)} ETH`);
  console.log(`balance      ${formatEther(balance)} ETH`);

  if (Number(formatEther(balance)) < cfg.MIN_BALANCE_ETH) {
    console.warn(
      `\n⚠ hot wallet below ${cfg.MIN_BALANCE_ETH} ETH — top it up or withdrawals will start failing`,
    );
  }

  // Above ~1.5 the bounded loss stops being bounded in any useful sense: at
  // 2x the fee the hot wallet funds half of every withdrawal it relays.
  if (cfg.MAX_GAS_FEE_RATIO > 1.5) {
    console.warn(
      `\n⚠ MAX_GAS_FEE_RATIO=${cfg.MAX_GAS_FEE_RATIO} — this relayer will spend up to` +
        `\n  ${cfg.MAX_GAS_FEE_RATIO}x the fee it earns on every withdrawal, so the hot wallet` +
        `\n  drains rather than sustains itself. Fine while testing; not for a pool` +
        `\n  meant to keep running unattended.`,
    );
  }

  // Built here rather than lazily on first request so the cold scan happens
  // once at boot, when nobody is waiting on it, instead of landing on whichever
  // visitor happens to arrive first after a restart.
  const indexContract = cfg.INDEX_RPC_URL
    ? (pool.contract.connect(
        new JsonRpcProvider(cfg.INDEX_RPC_URL, cfg.CHAIN_ID, { staticNetwork: true }),
      ) as typeof pool.contract)
    : pool.contract;
  const logIndex = new LogIndex(indexContract, cfg.DEPLOY_BLOCK);
  logIndex.refresh().then(
    () => console.log(`log index ready from block ${cfg.DEPLOY_BLOCK}`),
    (e: unknown) => console.error(`log index cold start failed: ${String(e)}`),
  );
  // Deposits are the only thing that moves the tree. A client that arrives
  // between ticks still gets a correct answer — it reads the tail itself and
  // verifies the whole set against the chain either way.
  setInterval(() => void logIndex.refresh().catch(() => {}), 20_000);

  const app = createServer(cfg, pool, verifier, new SerialQueue(), logIndex);
  app.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`\nlistening on http://${cfg.HOST}:${cfg.PORT}`);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
