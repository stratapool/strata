import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, formatEther } from 'ethers';
import { loadConfig } from './config.js';
import { PoolClient } from './pool.js';
import { SerialQueue } from './queue.js';
import { createServer } from './server.js';
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

  if (cfg.MAX_GAS_FEE_RATIO > 1) {
    console.warn(
      `\n⚠ MAX_GAS_FEE_RATIO=${cfg.MAX_GAS_FEE_RATIO} — gas may exceed the fee, so this` +
        `\n  relayer will lose money on every withdrawal. Fine for a test pool;` +
        `\n  it will drain the hot wallet on anything long-lived.`,
    );
  }

  const app = createServer(cfg, pool, verifier, new SerialQueue());
  app.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`\nlistening on http://${cfg.HOST}:${cfg.PORT}`);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
