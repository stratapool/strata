/**
 * End-to-end exercise against the deployed pool, with no browser involved.
 *
 * Funds N throwaway wallets, deposits from each, then withdraws each note to a
 * fresh address through the relayer — and finally prints everything a chain
 * observer can see, so the unlinkability claim can be checked rather than
 * taken on trust.
 *
 * Uses @strata/shared, the same note and proof code the web client runs. A
 * separate implementation here would test itself rather than the product.
 *
 *   DEPLOYER_KEY=0x... node scripts/e2e-live.mjs --wallets 5
 *   DEPLOYER_KEY=0x... node scripts/e2e-live.mjs --wallets 5 --skip-withdraw
 *
 * What it proves: the contract accepts real proofs, rejects double spends, and
 * publishes no link between a deposit and its withdrawal.
 * What it does NOT prove: that the anonymity set is large enough to hide
 * anyone. With five notes it is five. That is a separate, statistical claim.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CIRCUITS = path.join(ROOT, 'circuits', 'build');
const WASM = path.join(CIRCUITS, 'withdraw_js', 'withdraw.wasm');
const ZKEY = path.join(CIRCUITS, 'withdraw_final.zkey');

const LEVELS = 20;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const N = Number(arg('wallets', 5));
const RELAYER_URL = arg('relayer', 'https://stratapool.xyz/relayer');
const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

const POOL_ABI = [
  'function deposit(bytes32 _commitment) external payable',
  'function denomination() view returns (uint256)',
  'function unspentNotes() view returns (uint256)',
  'function reserve() view returns (uint256)',
  'function isSpent(bytes32) view returns (bool)',
  'function getLastRoot() view returns (bytes32)',
  'function isSolvent() view returns (bool)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address indexed to, bytes32 nullifierHash, address indexed relayer, uint256 relayerFee)',
];

const eth = (v) => ethers.formatEther(v);
const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(74));

async function main() {
  const { crypto, MerkleTree, leInt2Buff } = await import('@strata/shared/note');
  const { proveWithdrawal } = await import('@strata/shared/proof');
  const { pedersenHash, hashLeftRight } = await crypto();

  const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
  const net = await provider.getNetwork();
  const info = JSON.parse(
    await readFile(path.join(HERE, '..', 'deployments', `${net.chainId}.json`), 'utf8'),
  );

  if (!process.env.DEPLOYER_KEY) throw new Error('set DEPLOYER_KEY');
  const funder = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  const pool = new ethers.Contract(info.contracts.pool, POOL_ABI, provider);
  const denomination = await pool.denomination();

  rule();
  line(`pool          ${info.contracts.pool}`);
  line(`chain         ${net.chainId}`);
  line(`denomination  ${eth(denomination)} ETH`);
  line(`funder        ${funder.address}  ${eth(await provider.getBalance(funder.address))} ETH`);
  line(`relayer api   ${RELAYER_URL}`);
  rule();

  // What each throwaway wallet needs: the note itself plus its own gas. A
  // wallet holding exactly the denomination cannot deposit — it has nothing
  // left to pay with.
  const depositGas = 1_200_000n;
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 1n;
  const perWallet = denomination + depositGas * gasPrice * 2n;
  line(`funding ${N} wallets with ${eth(perWallet)} ETH each` +
       ` (${eth(denomination)} note + gas)`);

  const needed = perWallet * BigInt(N) + 21_000n * gasPrice * BigInt(N) * 2n;
  const have = await provider.getBalance(funder.address);
  if (have < needed) {
    throw new Error(`funder needs ~${eth(needed)} ETH, has ${eth(have)}`);
  }

  // ---------------------------------------------------------------- deposit
  // Every key this run creates is written out before it is funded. An earlier
  // version kept only the addresses, and the run's 0.05 ETH ended up in five
  // wallets nobody could open — spent, not lost to a bug, but unrecoverable
  // all the same.
  const keyFile = path.join(HERE, '..', 'deployments', `e2e-keys-${net.chainId}.json`);
  const keys = [];
  const saveKeys = async () =>
    writeFile(keyFile, JSON.stringify(keys, null, 2));

  const actors = [];
  for (let i = 0; i < N; i++) {
    const w = ethers.Wallet.createRandom().connect(provider);
    keys.push({ role: 'depositor', index: i, address: w.address, privateKey: w.privateKey });
    await saveKeys();
    const tx = await funder.sendTransaction({ to: w.address, value: perWallet });
    await tx.wait();

    const nullifier = randomField();
    const secret = randomField();
    const commitment = pedersenHash(
      concat(leInt2Buff(nullifier, 31), leInt2Buff(secret, 31)),
    );
    const nullifierHash = pedersenHash(leInt2Buff(nullifier, 31));

    const dep = await pool
      .connect(w)
      .deposit(ethers.toBeHex(commitment, 32), { value: denomination });
    const rc = await dep.wait();

    actors.push({ w, nullifier, secret, commitment, nullifierHash, depositTx: rc.hash });
    line(`  ${i + 1}/${N}  deposit from ${w.address}  tx ${rc.hash.slice(0, 18)}…`);
  }

  rule();
  line(`unspent notes now: ${await pool.unspentNotes()}`);
  line(`pool solvent:      ${await pool.isSolvent()}`);

  if (flag('skip-withdraw')) {
    line('\n--skip-withdraw: stopping before withdrawals.');
    return;
  }

  // ---------------------------------------------------------------- withdraw
  rule();
  const events = await pool.queryFilter(pool.filters.Deposit(), info.deployBlock, 'latest');
  const leaves = events
    .sort((a, b) => Number(a.args.leafIndex) - Number(b.args.leafIndex))
    .map((e) => BigInt(e.args.commitment));
  const tree = new MerkleTree(LEVELS, hashLeftRight, leaves);

  const onchainRoot = await pool.getLastRoot();
  const jsRoot = ethers.toBeHex(tree.root(), 32);
  line(`merkle root  chain ${onchainRoot.slice(0, 20)}…`);
  line(`             local ${jsRoot.slice(0, 20)}…   ${onchainRoot.toLowerCase() === jsRoot.toLowerCase() ? 'MATCH' : 'MISMATCH'}`);
  if (onchainRoot.toLowerCase() !== jsRoot.toLowerCase()) {
    throw new Error('client and contract disagree about the tree; refusing to prove');
  }

  const relayerInfo = await (await fetch(`${RELAYER_URL}/info`)).json();
  line(`relayer      ${relayerInfo.relayer}`);
  rule();

  // Withdraw in a shuffled order, so the sequence of withdrawals carries no
  // information about the sequence of deposits.
  const order = shuffle([...actors.keys()]);
  for (const idx of order) {
    const a = actors[idx];
    const leafIndex = leaves.findIndex((c) => c === a.commitment);
    const recipientWallet = ethers.Wallet.createRandom();
    const recipient = recipientWallet.address;
    keys.push({ role: 'recipient', leafIndex, address: recipient, privateKey: recipientWallet.privateKey });
    await saveKeys();

    const { proof, root } = await proveWithdrawal({
      note: a,
      tree,
      leafIndex,
      recipient,
      relayer: relayerInfo.relayer,
      wasmPath: WASM,
      zkeyPath: ZKEY,
    });

    const res = await fetch(`${RELAYER_URL}/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proof,
        root: ethers.toBeHex(root, 32),
        nullifierHash: ethers.toBeHex(a.nullifierHash, 32),
        recipient,
        relayer: relayerInfo.relayer,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      line(`  leaf ${leafIndex}  REJECTED: ${body.error}`);
      continue;
    }
    a.recipient = recipient;
    a.withdrawTx = body.txHash;
    const got = await provider.getBalance(recipient);
    line(`  leaf ${leafIndex} → ${recipient}  ${eth(got)} ETH  tx ${body.txHash.slice(0, 18)}…`);
  }

  // -------------------------------------------------------- double spend
  rule();
  const victim = actors.find((a) => a.withdrawTx);
  if (victim) {
    const leafIndex = leaves.findIndex((c) => c === victim.commitment);
    const { proof, root } = await proveWithdrawal({
      note: victim, tree, leafIndex,
      recipient: ethers.Wallet.createRandom().address,
      relayer: relayerInfo.relayer, wasmPath: WASM, zkeyPath: ZKEY,
    });
    const res = await fetch(`${RELAYER_URL}/relay`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proof, root: ethers.toBeHex(root, 32),
        nullifierHash: ethers.toBeHex(victim.nullifierHash, 32),
        recipient: ethers.Wallet.createRandom().address,
        relayer: relayerInfo.relayer,
      }),
    });
    const body = await res.json();
    line(`double spend of a burned note: ${res.ok ? 'ACCEPTED — BUG' : 'rejected — ' + body.error}`);
  }

  await observerView(pool, info, provider, actors);

  rule();
  line(`Every key this run generated is in ${path.relative(process.cwd(), keyFile)}.`);
  line('It is gitignored. Sweep the balances back out before deleting it, or');
  line('the funds sitting in those addresses become unreachable.');
}

/**
 * Everything a chain analyst can see, printed side by side with the mapping
 * only we know. If any column of the public data reproduced the secret
 * mapping, the pool would not be doing its job.
 */
async function observerView(pool, info, provider, actors) {
  rule();
  line('WHAT AN OBSERVER SEES ON-CHAIN');
  rule();

  const deps = await pool.queryFilter(pool.filters.Deposit(), info.deployBlock, 'latest');
  const wds = await pool.queryFilter(pool.filters.Withdrawal(), info.deployBlock, 'latest');

  line('\ndeposits (public):');
  for (const e of deps) {
    const tx = await provider.getTransaction(e.transactionHash);
    line(`  leaf ${String(e.args.leafIndex).padStart(3)}  from ${tx.from}  commitment ${e.args.commitment.slice(0, 14)}…`);
  }

  line('\nwithdrawals (public):');
  for (const e of wds) {
    line(`  to ${e.args.to}  nullifierHash ${e.args.nullifierHash.slice(0, 14)}…`);
  }

  line('\nthe link, which only the note holder knows:');
  for (const a of actors.filter((x) => x.recipient)) {
    line(`  ${a.w.address}  →  ${a.recipient}`);
  }

  rule();
  const spent = actors.filter((a) => a.withdrawTx).length;
  line(`deposits: ${deps.length}   withdrawals: ${wds.length}   pairs we know: ${spent}`);
  line('');
  line('Check for yourself: nothing above pairs a depositor with a recipient.');
  line('A commitment is Pedersen(nullifier, secret) and a nullifierHash is');
  line('Pedersen(nullifier) — recovering one from the other means inverting');
  line('the hash. Order does not help either: withdrawals were submitted in a');
  line('shuffled order, and the relayer, not the depositor, sent every one.');
  line('');
  line(`Anonymity set here is ${await pool.unspentNotes()} unspent notes. Cryptographic`);
  line('unlinkability is not the same as having enough cover — with a handful');
  line('of notes, timing alone would narrow it. That needs volume, not code.');
  rule();
}

const randomField = () =>
  BigInt('0x' + Buffer.from(ethers.randomBytes(31)).toString('hex'));

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Number(ethers.toBigInt(ethers.randomBytes(4)) % BigInt(i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\nFAILED:', e.message ?? e);
    process.exit(1);
  },
);
