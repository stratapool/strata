/**
 * Seeds the pool with notes derived from a wallet, not from random bytes.
 *
 *   SEED_KEY=0x... node scripts/seed-pool.mjs --notes 50
 *   SEED_KEY=0x... node scripts/seed-pool.mjs --notes 50 --skip-proof
 *
 * Two earlier runs of the end-to-end script lost 0.08 ETH between them. Both
 * times the note secrets were generated randomly and existed in exactly one
 * place — a file the script was responsible for writing — and both times the
 * writing was incomplete in a way nobody noticed until the money was gone.
 *
 * This script has no such file. Every note comes from
 * `deriveNoteSecrets(seedFromSignature(sign(DERIVATION_MESSAGE)), i)`, the same
 * derivation the browser uses, so the wallet *is* the backup. Delete this
 * machine and the notes are still recoverable by signing the same message
 * again, on any device, forever.
 *
 * It also refuses to seed at scale on trust. The first note is deposited alone,
 * and then recovered from nothing but the wallet — rederived, located on chain,
 * and proven spendable against the real proving key — before the rest are
 * funded. "The file has the keys in it" was the check that failed twice; this
 * checks the thing that actually matters, which is whether the money can come
 * back out.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CIRCUITS = path.join(ROOT, 'circuits', 'build');
const WASM = path.join(CIRCUITS, 'withdraw_js', 'withdraw.wasm');
const ZKEY = path.join(CIRCUITS, 'withdraw_final.zkey');
const VKEY = path.join(CIRCUITS, 'verification_key.json');

const LEVELS = 20;
/** Matches the browser's scanner: deposits are sequential, so a run this long means the end. */
const GAP_LIMIT = 20;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const WANT = Number(arg('notes', 1));
const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

const POOL_ABI = [
  'function deposit(bytes32 _commitment) external payable',
  'function denomination() view returns (uint256)',
  'function unspentNotes() view returns (uint256)',
  'function isSpent(bytes32) view returns (bool)',
  'function isSolvent() view returns (bool)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
];

const eth = (v) => ethers.formatEther(v);
const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(74));

async function main() {
  if (!process.env.SEED_KEY) throw new Error('set SEED_KEY');

  const { crypto, MerkleTree, leInt2Buff } = await import('@strata/shared/note');
  const { proveWithdrawal } = await import('@strata/shared/proof');
  const { DERIVATION_MESSAGE, seedFromSignature, deriveNoteSecrets } =
    await import('@strata/shared/keys');
  const { pedersenHash, hashLeftRight } = await crypto();

  const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
  const net = await provider.getNetwork();
  const info = JSON.parse(
    await readFile(path.join(HERE, '..', 'deployments', `${net.chainId}.json`), 'utf8'),
  );

  const wallet = new ethers.Wallet(process.env.SEED_KEY, provider);
  const pool = new ethers.Contract(info.contracts.pool, POOL_ABI, provider);
  const denomination = await pool.denomination();

  const concat = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };
  const commitmentOf = ({ nullifier, secret }) =>
    pedersenHash(concat(leInt2Buff(nullifier, 31), leInt2Buff(secret, 31)));

  // Derived once here, and never written anywhere. Recovery re-derives it.
  const seed = seedFromSignature(await wallet.signMessage(DERIVATION_MESSAGE));

  rule();
  line(`pool          ${info.contracts.pool}`);
  line(`denomination  ${eth(denomination)} ETH`);
  line(`wallet        ${wallet.address}  ${eth(await provider.getBalance(wallet.address))} ETH`);
  line(`notes wanted  ${WANT}`);
  line('');
  line('Notes are derived from this wallet, not randomly generated. Nothing');
  line('this script writes is needed to recover them — signing the same');
  line('message again reproduces every key, on any device.');
  rule();

  // ------------------------------------------------------------- where to start
  // Reuse of an index is not merely wasteful: the contract rejects a duplicate
  // commitment, so the deposit reverts. Scan for what this wallet already has.
  const events = await pool.queryFilter(pool.filters.Deposit(), info.deployBlock, 'latest');
  const onChain = new Map(
    events.map((e) => [BigInt(e.args.commitment).toString(), Number(e.args.leafIndex)]),
  );
  line(`pool holds ${onChain.size} commitments in total`);

  let startIndex = 0;
  let misses = 0;
  const mine = [];
  for (let i = 0; misses < GAP_LIMIT; i++) {
    const note = deriveNoteSecrets(seed, i);
    const c = commitmentOf(note).toString();
    if (onChain.has(c)) {
      mine.push(i);
      startIndex = i + 1;
      misses = 0;
    } else {
      misses += 1;
    }
  }
  line(`this wallet already owns ${mine.length}; next free index is ${startIndex}`);

  const cost = denomination * BigInt(WANT);
  const balance = await provider.getBalance(wallet.address);
  const feeData = await provider.getFeeData();
  const gasPer = 1_200_000n * (feeData.gasPrice ?? 1n);
  const needed = cost + gasPer * BigInt(WANT);
  line(`need ~${eth(needed)} ETH (${eth(cost)} principal + ${eth(needed - cost)} gas)`);
  if (balance < needed) throw new Error(`wallet has ${eth(balance)} ETH, needs ~${eth(needed)}`);

  if (flag('dry-run')) {
    line('\n--dry-run: stopping before any deposit.');
    return;
  }

  // --------------------------------------------------------------- stage one
  rule();
  line('STAGE 1 — one note, then prove it can come back out');
  const first = deriveNoteSecrets(seed, startIndex);
  const firstCommitment = commitmentOf(first);
  const tx = await pool
    .connect(wallet)
    .deposit(ethers.toBeHex(firstCommitment, 32), { value: denomination });
  const rc = await tx.wait();
  line(`  deposited index ${startIndex}  tx ${rc.hash}`);

  if (flag('skip-proof')) {
    line('\n--skip-proof: NOT verifying recoverability. This is the check that');
    line('caught nothing twice before. You are on your own.');
  } else {
    await proveRecoverable({
      label: startIndex,
      provider, pool, info, wallet,
      deps: { MerkleTree, hashLeftRight, pedersenHash, leInt2Buff, proveWithdrawal, commitmentOf,
              DERIVATION_MESSAGE, seedFromSignature, deriveNoteSecrets },
    });
  }

  // -------------------------------------------------------------- stage two
  const rest = WANT - 1;
  if (rest <= 0) {
    line('\nDone. Only one note was requested.');
    return;
  }

  rule();
  line(`STAGE 2 — remaining ${rest} notes`);
  for (let k = 0; k < rest; k++) {
    const i = startIndex + 1 + k;
    const c = commitmentOf(deriveNoteSecrets(seed, i));
    const t = await pool
      .connect(wallet)
      .deposit(ethers.toBeHex(c, 32), { value: denomination });
    await t.wait();
    if ((k + 1) % 10 === 0 || k === rest - 1) {
      line(`  ${k + 1}/${rest}  (index ${i})`);
    }
  }

  rule();
  line(`unspent notes now: ${await pool.unspentNotes()}`);
  line(`pool solvent:      ${await pool.isSolvent()}`);
  line(`wallet left:       ${eth(await provider.getBalance(wallet.address))} ETH`);
  line('');
  line('To recover every note: connect this wallet to the site and unlock.');
  line('Nothing else is required, and nothing on this machine matters.');
  rule();
}

/**
 * Rebuilds a note from the wallet alone and proves it spendable.
 *
 * Deliberately re-derives from scratch — re-signs the message, re-scans the
 * chain — rather than reusing anything already in memory. The point is to
 * answer "if this process died right now, could the money come back?", and
 * reusing a live variable would answer a question nobody is asking.
 *
 * Generating the proof and verifying it against the real verification key is
 * the strong form of that check. Finding the commitment only shows the note is
 * *there*; a valid proof shows it is spendable.
 */
async function proveRecoverable({ label, provider, pool, info, wallet, deps }) {
  const {
    MerkleTree, hashLeftRight, pedersenHash, leInt2Buff, proveWithdrawal,
    commitmentOf, DERIVATION_MESSAGE, seedFromSignature, deriveNoteSecrets,
  } = deps;

  line('  recovering it with nothing but the wallet…');
  const freshSeed = seedFromSignature(await wallet.signMessage(DERIVATION_MESSAGE));
  const note = deriveNoteSecrets(freshSeed, label);
  const commitment = commitmentOf(note);

  const events = await pool.queryFilter(pool.filters.Deposit(), info.deployBlock, 'latest');
  const sorted = events.sort((a, b) => Number(a.args.leafIndex) - Number(b.args.leafIndex));
  const leaves = sorted.map((e) => BigInt(e.args.commitment));
  const leafIndex = leaves.findIndex((l) => l === commitment);
  if (leafIndex < 0) {
    throw new Error(
      `RECOVERY FAILED: note ${label} rederived from the wallet is not in the tree. ` +
        'Do not deposit anything further — the derivation used to deposit and the ' +
        'derivation used to recover disagree.',
    );
  }
  line(`  found at leaf ${leafIndex}`);

  const tree = new MerkleTree(LEVELS, hashLeftRight, leaves);
  const nullifierHash = pedersenHash(leInt2Buff(note.nullifier, 31));

  const { proof, root } = await proveWithdrawal({
    note: { ...note, commitment, nullifierHash },
    tree,
    leafIndex,
    // Never submitted; the proof only has to verify. A burn address makes that
    // unambiguous if it ever leaks into a log.
    recipient: '0x000000000000000000000000000000000000dEaD',
    relayer: ethers.ZeroAddress,
    wasmPath: WASM,
    zkeyPath: ZKEY,
  });

  const snarkjs = await import('snarkjs');
  const vkey = JSON.parse(await readFile(VKEY, 'utf8'));
  const { publicSignals, fromSolidityCalldata } = await import('@strata/shared/proof');
  const signals = publicSignals({
    root,
    nullifierHash,
    recipient: '0x000000000000000000000000000000000000dEaD',
    relayer: ethers.ZeroAddress,
  });
  const ok = await snarkjs.groth16.verify(vkey, signals, fromSolidityCalldata(proof));
  if (!ok) {
    throw new Error(
      'RECOVERY FAILED: the note was found but its withdrawal proof does not ' +
        'verify. Do not deposit anything further.',
    );
  }

  line('  ✓ rederived from the wallet, located on chain, and proven spendable');
  line('    (the proof was verified, not submitted — the note is still unspent)');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\n${e.message ?? e}`);
    process.exit(1);
  },
);
