/**
 * Spreads ETH from one funding wallet across the ten derived operating wallets.
 *
 *   node scripts/split-eth.mjs --from 0 --amount 1.0
 *   node scripts/split-eth.mjs --from 0 --amount 1.0 --dry-run
 *   FUNDER_KEY=0x… node scripts/split-eth.mjs --amount 1.0
 *
 * Reads deployments/wallets-<chainId>.json — the wallets derived from the
 * mnemonic — and moves an equal share to each. Either fund from one of those
 * ten (--from N) or from an outside wallet (FUNDER_KEY).
 *
 * It leaves the funder's share alone rather than shuffling money in a circle:
 * with --from 0 and --amount 1.0, wallets 1..9 each receive 0.1 and wallet 0
 * simply keeps what remains. Sending 0.1 from wallet 0 to wallet 0 would burn
 * gas to accomplish nothing, and the intent is ten wallets holding a tenth
 * each, not ten transfers.
 *
 * Transfers are sequential and one per recipient. Batching through a contract
 * would be cheaper, but it would also publish "these ten addresses were funded
 * together" in a single transaction — which is the link that makes ten wallets
 * worth exactly as much as one.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = 4663;
const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);
const eth = (v) => ethers.formatEther(v);
const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(72));

async function main() {
  const amount = arg('amount');
  if (!amount) throw new Error('pass --amount <total ETH to spread>');

  const wallets = JSON.parse(
    await readFile(path.join(HERE, '..', 'deployments', `wallets-${CHAIN_ID}.json`), 'utf8'),
  );

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });

  const fromIndex = arg('from');
  let funder;
  let skipIndex = -1;
  if (process.env.FUNDER_KEY) {
    funder = new ethers.Wallet(process.env.FUNDER_KEY, provider);
  } else if (fromIndex !== undefined) {
    const w = wallets[Number(fromIndex)];
    if (!w) throw new Error(`no wallet at index ${fromIndex}`);
    funder = new ethers.Wallet(w.privateKey, provider);
    skipIndex = Number(fromIndex);
  } else {
    throw new Error('pass --from <index> or set FUNDER_KEY');
  }

  const targets = wallets.filter((w) => w.index !== skipIndex);
  const total = ethers.parseEther(String(amount));
  // Per-wallet share is the total over ten, not over the number of recipients:
  // the funder is one of the ten and keeps its own share in place.
  const share = total / BigInt(wallets.length);

  const feeData = await provider.getFeeData();
  const gasPer = 21_000n * (feeData.gasPrice ?? 1n);
  const needed = share * BigInt(targets.length) + gasPer * BigInt(targets.length);
  const balance = await provider.getBalance(funder.address);

  rule();
  line(`funder      ${funder.address}  ${eth(balance)} ETH`);
  line(`recipients  ${targets.length}${skipIndex >= 0 ? ` (index ${skipIndex} keeps its own share)` : ''}`);
  line(`share each  ${eth(share)} ETH`);
  line(`need       ~${eth(needed)} ETH (${eth(share * BigInt(targets.length))} + gas)`);
  rule();

  if (balance < needed) {
    throw new Error(`funder has ${eth(balance)} ETH, needs ~${eth(needed)}`);
  }

  if (flag('dry-run')) {
    for (const w of targets) line(`  would send ${eth(share)} -> ${w.address}  (index ${w.index})`);
    line('\n--dry-run: nothing sent.');
    return;
  }

  for (const w of targets) {
    const tx = await funder.sendTransaction({ to: w.address, value: share });
    await tx.wait();
    line(`  ${eth(share)} -> ${w.address}  (index ${w.index})  ${tx.hash}`);
  }

  rule();
  line('final balances:');
  for (const w of wallets) {
    line(`  ${String(w.index).padStart(2)}  ${w.address}  ${eth(await provider.getBalance(w.address))} ETH`);
  }
  rule();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\n${e.message ?? e}`);
    process.exit(1);
  },
);
