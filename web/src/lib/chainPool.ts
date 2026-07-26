import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  type Eip1193Provider,
} from 'ethers';
import { assess } from './privacy';
import { Prover } from './prover';
import { deriveNoteSecrets } from './keys';
import { noteVault } from './noteVault';
import {
  PLANNED_DENOMINATIONS,
  FEE,
  type DenomTier,
  type Denomination,
  type DepositRequest,
  type FeeBreakdown,
  type Note,
  type PoolClient,
  type PoolState,
  type PrivacyAssessment,
  type Split,
  type WithdrawRequest,
} from './types';

const POOL_ABI = [
  'function deposit(bytes32 _commitment) external payable',
  'function isSpent(bytes32 _nullifierHash) external view returns (bool)',
  'function getLastRoot() external view returns (bytes32)',
  'function denomination() external view returns (uint256)',
  'function unspentNotes() external view returns (uint256)',
  'function reserve() external view returns (uint256)',
  'function nextIndex() external view returns (uint32)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
];

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
  poolAddress: string;
  deployBlock: number;
  relayerUrl: string;
  proverAssets: { wasm: string; zkey: string };
}

interface DepositRecord {
  commitment: bigint;
  leafIndex: number;
  timestamp: number;
}

/**
 * Talks to the deployed pool.
 *
 * Deliberately the same shape as MockPool: everything above this file — every
 * component, every screen — is unchanged between the demo and the real thing.
 */
export class ChainPool implements PoolClient {
  readonly #cfg: ChainConfig;
  readonly #read: JsonRpcProvider;
  readonly #contract: Contract;
  readonly #prover: Prover;
  readonly #listeners = new Set<(s: PoolState) => void>();

  #wallet: Eip1193Provider | null = null;
  #account: string | null = null;
  #seed: string | null = null;

  #state: PoolState;
  #deposits: DepositRecord[] = [];
  #notes: Note[] = [];
  /** noteId -> secrets, so spending does not care where a note came from. */
  #secrets = new Map<string, { nullifier: bigint; secret: bigint }>();
  /** Next unused derivation index; imported notes do not consume one. */
  #nextDerivedIndex = 0;
  #denomination = 0n;
  #poll: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: ChainConfig) {
    this.#cfg = cfg;
    this.#read = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, {
      staticNetwork: true,
    });
    this.#contract = new Contract(cfg.poolAddress, POOL_ABI, this.#read);
    this.#prover = new Prover(cfg.proverAssets);
    this.#state = emptyState(cfg.chainId);
  }

  async connect(wallet: Eip1193Provider, account: string): Promise<void> {
    this.#wallet = wallet;
    this.#account = account;
  }

  setSeed(seed: string): void {
    this.#seed = seed;
  }

  async start(): Promise<void> {
    this.#denomination = await this.#contract.denomination!();
    await this.refresh();
    // Deposits are the only thing that moves the tree; polling is enough and
    // avoids depending on websocket support from the RPC.
    this.#poll = setInterval(() => void this.refresh(), 15_000);
  }

  stop(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    this.#listeners.clear();
  }

  async refresh(): Promise<void> {
    const [unspent, reserveWei, events] = await Promise.all([
      this.#contract.unspentNotes!(),
      this.#contract.reserve!(),
      this.#contract.queryFilter(
        this.#contract.filters.Deposit!(),
        this.#cfg.deployBlock,
        'latest',
      ),
    ]);

    this.#deposits = events
      .map((e) => {
        const args = (e as unknown as { args: Record<string, unknown> }).args;
        return {
          commitment: BigInt(args.commitment as string),
          leafIndex: Number(args.leafIndex),
          timestamp: Number(args.timestamp),
        };
      })
      .sort((a, b) => a.leafIndex - b.leafIndex);

    // Straight from the contract. This pool has exactly one size and it is
    // whatever was set at deployment — nothing here gets to second-guess it.
    const denomination = Number(this.#denomination) / 1e18;
    const notes = Number(unspent);

    this.#state = {
      chainId: this.#cfg.chainId,
      // The live pool first, then the sizes we plan to run later. Planned
      // ones are a roadmap — each needs its own deployment and starts with an
      // empty anonymity set — so they are never shown as "unlocking".
      tiers: [
        { value: denomination, open: true, unlockThreshold: 0, unspentNotes: notes, ethLocked: notes * denomination },
        ...PLANNED_DENOMINATIONS.filter((d) => Math.abs(d - denomination) > 1e-9).map<DenomTier>((d) => ({
          value: d, open: false, unlockThreshold: 0, unspentNotes: 0, ethLocked: 0,
        })),
      ].sort((a, b) => a.value - b.value),
      totalUnspentNotes: notes,
      totalEthInPool: notes * denomination,
      reserveEth: Number(reserveWei) / 1e18,
      // Distinct depositor count is not observable on-chain by design — every
      // deposit is meant to be unattributable. Reporting the deposit count
      // instead of inventing a number keeps the figure honest.
      uniqueDepositors: this.#deposits.length,
      reserveHistory: [],
      avgNoteAgeDays: this.#averageAgeDays(),
      anonSetGrowth30d: 0,
    };

    await this.#rescanNotes();
    for (const l of this.#listeners) l(this.#state);
  }

  #averageAgeDays(): number {
    if (!this.#deposits.length) return 0;
    const now = Date.now() / 1000;
    const total = this.#deposits.reduce((a, d) => a + (now - d.timestamp), 0);
    return total / this.#deposits.length / 86_400;
  }

  /**
   * Finds which on-chain commitments this client can spend.
   *
   * Two sources, handled uniformly because withdrawing must not care which
   * one a note came from:
   *
   *  - derived from the wallet seed, recoverable on any device with the same
   *    wallet;
   *  - imported from a note string someone handed over, whose secrets came
   *    from *their* seed and therefore exist nowhere but local storage.
   *
   * Scanning is entirely local. The chain is public, so no query here reveals
   * which leaves are ours — asking a server would.
   */
  async #rescanNotes(): Promise<void> {
    const { crypto, leInt2Buff } = await import('@strata/shared/note');
    const { pedersenHash } = await crypto();

    const byCommitment = new Map(this.#deposits.map((d) => [d.commitment, d]));
    const found: Note[] = [];
    const secrets = new Map<string, { nullifier: bigint; secret: bigint }>();
    const denomination = Number(this.#denomination) / 1e18;

    const consider = async (
      id: string,
      nullifier: bigint,
      secret: bigint,
    ): Promise<boolean> => {
      const commitment = pedersenHash(
        concat(leInt2Buff(nullifier, 31), leInt2Buff(secret, 31)),
      );
      const record = byCommitment.get(commitment);
      if (!record) return false;
      const nullifierHash = pedersenHash(leInt2Buff(nullifier, 31));
      const spent = Boolean(await this.#contract.isSpent!(toHex32(nullifierHash)));
      secrets.set(id, { nullifier, secret });
      found.push({
        id,
        denomination,
        leafIndex: record.leafIndex,
        createdAt: record.timestamp * 1000,
        spent,
      });
      return true;
    };

    if (this.#seed) {
      // Walk indices until a run of misses; deposits are made sequentially,
      // so a gap this long means we are past the end.
      const GAP_LIMIT = 20;
      let misses = 0;
      for (let i = 0; misses < GAP_LIMIT; i++) {
        const { nullifier, secret } = deriveNoteSecrets(this.#seed, i);
        misses = (await consider(`note-${i}`, nullifier, secret)) ? 0 : misses + 1;
      }
      this.#nextDerivedIndex = found.length;
    }

    for (const entry of noteVault.all()) {
      await consider(
        `imported-${entry.nullifier.slice(0, 12)}`,
        BigInt(entry.nullifier),
        BigInt(entry.secret),
      );
    }

    this.#notes = found;
    this.#secrets = secrets;
  }

  /** Serialised forms of notes this client holds, for handing to someone else. */
  async exportNotes(ids: string[]): Promise<{ id: string; encoded: string }[]> {
    const { encodeNote } = await import('@strata/shared/note');
    return ids.flatMap((id) => {
      const s = this.#secrets.get(id);
      return s ? [{ id, encoded: encodeNote(s) }] : [];
    });
  }

  /**
   * Accepts a note string from someone else.
   *
   * Verified against the chain before it is stored, so a mistyped or already
   * spent note fails here rather than silently inflating the displayed
   * balance and then failing at withdrawal.
   */
  async importNote(encoded: string): Promise<
    | { ok: true; denomination: number }
    | { ok: false; reason: string }
  > {
    const { decodeNote, leInt2Buff, crypto } = await import('@strata/shared/note');
    let note;
    try {
      note = await decodeNote(encoded);
    } catch {
      return { ok: false, reason: 'That does not look like a Strata note.' };
    }

    const known = this.#deposits.some((d) => d.commitment === note.commitment);
    if (!known) {
      return {
        ok: false,
        reason: 'No deposit in this pool matches that note. Check you are on the right pool.',
      };
    }

    const { pedersenHash } = await crypto();
    const nullifierHash = pedersenHash(leInt2Buff(note.nullifier, 31));
    if (await this.#contract.isSpent!(toHex32(nullifierHash))) {
      return { ok: false, reason: 'That note has already been spent.' };
    }

    const added = noteVault.add({
      nullifier: '0x' + note.nullifier.toString(16),
      secret: '0x' + note.secret.toString(16),
      encoded: encoded.trim(),
    });
    if (!added.added) return { ok: false, reason: 'You have already imported that note.' };

    await this.refresh();
    return { ok: true, denomination: Number(this.#denomination) / 1e18 };
  }

  // ---------------------------------------------------------- PoolClient --

  getState(): PoolState {
    return this.#state;
  }

  subscribe(listener: (s: PoolState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getNotes(): Note[] {
    return this.#notes.filter((n) => !n.spent);
  }

  getBalance(): number {
    return this.getNotes().reduce((a, n) => a + n.denomination, 0);
  }

  splitAmount(amount: number): Split {
    const open = this.#state.tiers.filter((t) => t.open).map((t) => t.value);
    const unit = open.length ? Math.min(...open) : 0.1;
    const units = Math.floor(Number((Math.max(0, amount) / unit).toFixed(6)));
    const covered = Number((units * unit).toFixed(6));
    return {
      parts: units > 0 ? [{ denomination: unit as Denomination, count: units }] : [],
      totalNotes: units,
      coveredAmount: covered,
      remainder: Number((Math.max(0, amount) - covered).toFixed(6)),
    };
  }

  quoteWithdrawal(amount: number): FeeBreakdown {
    const relayerFee = (amount * FEE.RELAYER_BPS) / 10000;
    const reserveFee = (amount * FEE.RESERVE_BPS) / 10000;
    return { gross: amount, relayerFee, reserveFee, net: amount - relayerFee - reserveFee };
  }

  assessPrivacy(): PrivacyAssessment {
    const mine = this.getNotes();
    const oldest = mine.reduce<Note | null>(
      (a, n) => (a === null || n.createdAt < a.createdAt ? n : a),
      null,
    );
    if (!oldest) return assess(this.#state.totalUnspentNotes, 0);

    const ageHours = (Date.now() - oldest.createdAt) / 3_600_000;
    // Only deposits that already existed when ours landed could be confused
    // with it; later ones are visibly later.
    const before = this.#deposits.filter((d) => d.leafIndex <= oldest.leafIndex).length;
    return assess(Math.max(1, before), ageHours);
  }

  estimateDepositGas(noteCount: number): number {
    // Measured against the deployed pool: a deposit costs ~1,083,000 gas
    // (twenty MiMC rounds inserting the leaf), which at this chain's
    // ~0.054 gwei is about 0.000058 ETH. The previous 0.000021 was a guess
    // and understated the real cost by roughly three times.
    return Number((0.000058 * Math.max(1, noteCount)).toFixed(6));
  }

  async deposit(req: DepositRequest, onStep: (i: number) => void): Promise<void> {
    if (!this.#wallet || !this.#account) throw new Error('wallet not connected');
    if (!this.#seed) throw new Error('note keys not derived');

    const { crypto, leInt2Buff } = await import('@strata/shared/note');
    const { pedersenHash } = await crypto();

    onStep(0);
    const split = this.splitAmount(req.amount);
    // Derivation indices, not note count: imported notes are in #notes but
    // were never derived, so counting them would skip indices and leave gaps
    // the scanner would have to walk past.
    const startIndex = this.#nextDerivedIndex;

    onStep(1);
    const commitments: bigint[] = [];
    for (let i = 0; i < split.totalNotes; i++) {
      const { nullifier, secret } = deriveNoteSecrets(this.#seed, startIndex + i);
      commitments.push(
        pedersenHash(concat(leInt2Buff(nullifier, 31), leInt2Buff(secret, 31))),
      );
    }

    onStep(2);
    const signer = await new BrowserProvider(this.#wallet).getSigner(this.#account);
    const writable = this.#contract.connect(signer) as Contract;
    // One transaction per note. Batching them would be cheaper but would also
    // publish "these N commitments arrived together", which is exactly the
    // link the split is meant to break.
    for (const commitment of commitments) {
      const tx = await writable.deposit!(toHex32(commitment), {
        value: this.#denomination,
      });
      await tx.wait();
    }

    onStep(3);
    await this.refresh();
  }

  async withdraw(req: WithdrawRequest, onStep: (i: number) => void): Promise<void> {
    if (!this.#seed) throw new Error('note keys not derived');

    const { crypto, MerkleTree, leInt2Buff } = await import('@strata/shared/note');
    const { toSolidityCalldata } = await import('@strata/shared/proof');
    const { hashLeftRight, pedersenHash } = await crypto();

    // Ask the relayer who it is rather than hardcoding: the address is baked
    // into the proof, so a stale value would produce proofs it cannot submit.
    const info = await fetch(`${this.#cfg.relayerUrl}/info`).then((r) => r.json());
    const relayerAddress: string = info.relayer;

    const tree = new MerkleTree(
      20,
      hashLeftRight,
      this.#deposits.map((d) => d.commitment),
    );
    const root = tree.root();

    const denomination = this.#state.tiers.find((t) => t.open)?.value ?? 0.1;
    const count = Math.round(req.amount / denomination);
    const spendable = this.getNotes().slice(0, count);
    if (spendable.length < count) throw new Error('insufficient private balance');

    // One note at a time. Each is a separate proof and a separate transaction;
    // submitting them together would tie them to each other on-chain.
    for (const [n, note] of spendable.entries()) {
      const held = this.#secrets.get(note.id);
      if (!held) throw new Error(`no secrets held for ${note.id}`);
      const { nullifier, secret } = held;
      const nullifierHash = pedersenHash(leInt2Buff(nullifier, 31));
      const { pathElements, pathIndices } = tree.path(note.leafIndex);

      onStep(0);
      const { proof: rawProof } = await this.#prover.prove({
        root,
        nullifierHash,
        recipient: BigInt(req.recipient),
        relayer: BigInt(relayerAddress),
        fee: 0n,
        refund: 0n,
        nullifier,
        secret,
        pathElements,
        pathIndices,
      });

      onStep(1);
      const res = await fetch(`${this.#cfg.relayerUrl}/relay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          proof: toSolidityCalldata(rawProof),
          root: toHex32(root),
          nullifierHash: toHex32(nullifierHash),
          recipient: req.recipient,
          relayer: relayerAddress,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `relayer rejected note ${n + 1} of ${count}`);
      }

      onStep(2);
    }

    onStep(3);
    await this.refresh();
  }

  /** Exposed so the UI can pre-download the proving key while the user reads. */
  warmUpProver(onProgress?: (p: { loaded: number; total: number }) => void) {
    return this.#prover.warmUp(onProgress);
  }
}

function emptyState(chainId: number): PoolState {
  return {
    chainId,
    tiers: PLANNED_DENOMINATIONS.map((d) => ({
      value: d,
      open: false,
      unlockThreshold: 0,
      unspentNotes: 0,
      ethLocked: 0,
    })),
    totalUnspentNotes: 0,
    totalEthInPool: 0,
    reserveEth: 0,
    uniqueDepositors: 0,
    reserveHistory: [],
    avgNoteAgeDays: 0,
    anonSetGrowth30d: 0,
  };
}

function toHex32(v: bigint): string {
  return '0x' + v.toString(16).padStart(64, '0');
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
