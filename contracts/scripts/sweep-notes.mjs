/**
 * Withdraws notes derived from a wallet, back out of the pool.
 *
 *   SEED_KEY=0x... node scripts/sweep-notes.mjs --to 0xRecipient
 *   SEED_KEY=0x... node scripts/sweep-notes.mjs --to 0xRecipient --limit 1
 *   SEED_KEY=0x... node scripts/sweep-notes.mjs --to 0xRecipient --self-submit
 *
 * The counterpart to seed-pool.mjs, and the answer to "can I get it back".
 * It takes nothing but the wallet: every note is rederived from a signature,
 * located by scanning the chain, and spent. No key file, no state, no
 * dependence on the machine that made the deposit.
 *
 * By default it relays, so the recipient never needs funding and never touches
 * an address that could be linked back. --self-submit pays gas from SEED_KEY
 * instead, which works when the relayer is down or refusing — at the cost of
 * publishing that this wallet paid for that withdrawal, which for a real user
 * is the whole thing they were buying. Use it to recover, not to hide.
 *
 * Notes already spent are skipped rather than retried: a burned nullifier
 * cannot be spent twice, and grinding at it just wastes proofs.
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

const LEVELS = 20;
const GAP_LIMIT = 20;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const TO = arg('to');
const LIMIT = Number(arg('limit', Infinity));
const RELAYER_URL = arg('relayer', 'https://stratapool.xyz/relayer');
const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

const POOL_ABI = [
  'function withdraw(uint256[2] a, uint256[2][2] b, uint256[2] c, bytes32 root, bytes32 nullifierHash, address recipient, address relayer) external',
  'function denomination() view returns (uint256)',
  'function unspentNotes() view returns (uint256)',
  'function isSpent(bytes32) view returns (bool)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
];

const eth = (v) => ethers.formatEther(v);
const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(74));

async function main() {
  if (!process.env.SEED_KEY) throw new Error('set SEED_KEY');
  if (!TO || !ethers.isAddress(TO)) throw new Error('pass --to 0xRecipient');

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

  const selfSubmit = flag('self-submit');
  let relayerAddress = ethers.ZeroAddress;
  if (!selfSubmit) {
    const res = await fetch(`${RELAYER_URL}/health`);
    if (!res.ok) throw new Error(`relayer ${RELAYER_URL} unhealthy: HTTP ${res.status}`);
    const health = await res.json();
    if (health.pool.toLowerCase() !== info.contracts.pool.toLowerCase()) {
      throw new Error(
        `relayer serves pool ${health.pool}, deployment says ${info.contracts.pool}`,
      );
    }
    relayerAddress = health.relayer;
  }

  rule();
  line(`pool          ${info.contracts.pool}`);
  line(`denomination  ${eth(denomination)} ETH`);
  line(`wallet        ${wallet.address}`);
  line(`recipient     ${TO}`);
  line(`route         ${selfSubmit ? 'self-submitted (gas from the wallet, not private)'
                                   : `relayer ${relayerAddress}`}`);
  rule();

  // ------------------------------------------------------------------- find
  const seed = seedFromSignature(await wallet.signMessage(DERIVATION_MESSAGE));
  const events = await pool.queryFilter(pool.filters.Deposit(), info.deployBlock, 'latest');
  const sorted = events.sort((a, b) => Number(a.args.leafIndex) - Number(b.args.leafIndex));
  const leaves = sorted.map((e) => BigInt(e.args.commitment));
  const byCommitment = new Map(leaves.map((l, i) => [l.toString(), i]));
  const tree = new MerkleTree(LEVELS, hashLeftRight, leaves);

  const found = [];
  let misses = 0;
  for (let i = 0; misses < GAP_LIMIT; i++) {
    const note = deriveNoteSecrets(seed, info.contracts.pool, i);
    const commitment = pedersenHash(
      concat(leInt2Buff(note.nullifier, 31), leInt2Buff(note.secret, 31)),
    );
    const leafIndex = byCommitment.get(commitment.toString());
    if (leafIndex === undefined) {
      misses += 1;
      continue;
    }
    misses = 0;
    const nullifierHash = pedersenHash(leInt2Buff(note.nullifier, 31));
    const spent = await pool.isSpent(ethers.toBeHex(nullifierHash, 32));
    found.push({ index: i, leafIndex, commitment, nullifierHash, spent, ...note });
  }

  const spendable = found.filter((n) => !n.spent).slice(0, LIMIT);
  line(`derived notes found: ${found.length}  (${found.filter((n) => n.spent).length} already spent)`);
  line(`withdrawing:         ${spendable.length}`);
  if (!spendable.length) {
    line('\nNothing to sweep.');
    return;
  }
  line(`expected payout:     ${eth(BigInt(spendable.length) * (denomination - denomination * 30n / 10_000n))} ETH`);
  rule();

  let ok = 0;
  for (const note of spendable) {
    const { proof, root } = await proveWithdrawal({
      note,
      tree,
      leafIndex: note.leafIndex,
      recipient: TO,
      relayer: relayerAddress,
      wasmPath: WASM,
      zkeyPath: ZKEY,
    });

    try {
      if (selfSubmit) {
        const tx = await pool
          .connect(wallet)
          .withdraw(
            proof.a, proof.b, proof.c,
            ethers.toBeHex(root, 32),
            ethers.toBeHex(note.nullifierHash, 32),
            TO,
            ethers.ZeroAddress,
          );
        const rc = await tx.wait();
        line(`  note ${note.index}  self-submitted  ${rc.hash}`);
      } else {
        const res = await fetch(`${RELAYER_URL}/relay`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            proof,
            root: ethers.toBeHex(root, 32),
            nullifierHash: ethers.toBeHex(note.nullifierHash, 32),
            recipient: TO,
            relayer: relayerAddress,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          line(`  note ${note.index}  REFUSED: ${body.error ?? res.status}`);
          continue;
        }
        // The relayer answers as soon as it has broadcast, so waiting here is
        // what makes the closing balance mean anything. Without it the summary
        // reported the recipient at 0.0 ETH on a withdrawal that landed fine.
        if (body.txHash) {
          const rc = await provider.waitForTransaction(body.txHash, 1, 180_000);
          if (!rc) {
            line(`  note ${note.index}  relayed ${body.txHash} — not mined within 180s`);
            continue;
          }
          if (rc.status !== 1) {
            line(`  note ${note.index}  REVERTED on chain  ${body.txHash}`);
            continue;
          }
          line(`  note ${note.index}  withdrawn  ${body.txHash}`);
        } else {
          line(`  note ${note.index}  relayed  ${JSON.stringify(body)}`);
        }
      }
      ok += 1;
    } catch (e) {
      line(`  note ${note.index}  FAILED: ${(e.message ?? e).slice(0, 140)}`);
    }
  }

  rule();
  line(`withdrawn:      ${ok}/${spendable.length}`);
  line(`recipient now:  ${eth(await provider.getBalance(TO))} ETH`);
  line(`unspent notes:  ${await pool.unspentNotes()}`);
  if (ok < spendable.length) {
    line('');
    line('Some notes were not withdrawn. They are not lost — nothing was spent');
    line('for them — so rerunning picks them up. If the relayer refused on gas,');
    line('either wait for it to fall or use --self-submit.');
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
