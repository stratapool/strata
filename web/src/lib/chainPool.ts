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
  type DepositReceipt,
  type DepositRequest,
  type FeeBreakdown,
  type Note,
  type PoolClient,
  type PoolState,
  type PrivacyAssessment,
  type Split,
  type WithdrawReceipt,
  type WithdrawRequest,
} from './types';

// isSpent is deliberately absent. The contract has it, but calling it per note
// is what leaked the user's note set to the RPC provider; spent-ness now comes
// from the Withdrawal log in bulk. Leaving it out means restoring that leak
// requires putting the entry back, which is visible in a diff.
const POOL_ABI = [
  'function deposit(bytes32 _commitment) external payable',
  'function getLastRoot() external view returns (bytes32)',
  'function denomination() external view returns (uint256)',
  'function unspentNotes() external view returns (uint256)',
  'function reserve() external view returns (uint256)',
  'function nextIndex() external view returns (uint32)',
  // Used to verify the relayer's log index. isKnownRoot rather than a
  // getLastRoot comparison: the contract keeps 120 roots, so a deposit
  // landing between the index's snapshot and this check does not fail an
  // honest answer.
  'function isKnownRoot(bytes32 _root) external view returns (bool)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address indexed to, bytes32 nullifierHash, address indexed relayer, uint256 relayerFee)',
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
  /**
   * Every nullifier hash the pool has ever burned, fetched in bulk.
   *
   * This exists so the client never asks about a *particular* note. It used to
   * call isSpent(nullifierHash) once per note it owned — and only for notes it
   * owned, since the call sat behind the commitment match. Each of those
   * requests told the RPC provider "this nullifier hash is mine", naming the
   * exact 32 bytes that appear on chain when that note is later spent. With
   * AppKit querying eth_getBalance for the connected address against the same
   * endpoint, one party held both halves of the link the whole protocol exists
   * to break, refreshed every fifteen seconds.
   *
   * Withdrawal events are public and undirected: fetching all of them reveals
   * nothing about which are yours, exactly as fetching all Deposit events
   * already did.
   */
  #spent = new Set<string>();
  /** leafIndex -> deposit, so a re-read of an overlapping range cannot duplicate. */
  #seenDeposits = new Map<number, DepositRecord>();
  /** Highest block whose logs are already folded in; 0 means nothing yet. */
  #scannedTo = 0;
  #notes: Note[] = [];
  /** noteId -> secrets, so spending does not care where a note came from. */
  #secrets = new Map<string, { nullifier: bigint; secret: bigint }>();
  /** Next unused derivation index; imported notes do not consume one. */
  #nextDerivedIndex = 0;
  /**
   * Derivation index -> the expensive half of scanning it.
   *
   * The scan re-derived every index from zero on each 15-second poll: three
   * keccaks and two Pedersen hashes per index, and Pedersen over bn254 in JS
   * costs ~12ms each. For a wallet holding 97 notes that is 117 indices and
   * about 2.7 seconds of synchronous main-thread work, repeating forever —
   * which is why tabs needed several clicks after connecting a wallet. The
   * clicks were not being missed; the thread was busy hashing.
   *
   * Index i under a fixed seed always yields the same values, so this is
   * computed once. What still runs every poll is the part that can change: a
   * Map lookup against the deposits and a Set lookup for spent-ness, both
   * free. Cleared whenever the seed changes — a stale entry here would report
   * the previous wallet's notes as the new wallet's.
   */
  #derived = new Map<
    number,
    { nullifier: bigint; secret: bigint; commitment: bigint; nullifierHash: bigint }
  >();
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

  /**
   * Accepts null so locking, or switching accounts, genuinely forgets.
   *
   * It used to take a string, and useStrata returned early when the seed went
   * null — so Lock cleared the UI gate and nothing else. The client kept the
   * seed, kept the derived secrets, and kept re-deriving them on every poll.
   * Switching from one wallet to another left the previous wallet's notes
   * still being scanned alongside the new wallet's balance query.
   */
  setSeed(seed: string | null): void {
    // Any change, not just locking. Switching from one wallet to another keeps
    // a non-null seed, and leaving the derivation cache in place across that
    // would attribute the previous wallet's notes to the new one.
    if (seed !== this.#seed) this.#derived.clear();
    this.#seed = seed;
    if (seed === null) {
      this.#notes = [];
      this.#secrets.clear();
      this.#nextDerivedIndex = 0;
    }
  }

  /**
   * Reloads a previous scan so a cold load is paid for once, not every visit.
   *
   * Walking 151k blocks takes ~26 seconds against this RPC and gets slower with
   * the chain. Caching it turns every later visit into a read of the new tail.
   *
   * What is stored is the public deposit log and the public nullifier log —
   * the same bytes anyone can pull from the chain, revealing nothing about
   * which of them are the visitor's. The note secrets are not here and never
   * touch storage; they are re-derived from the wallet signature each session.
   * A tampered or truncated cache cannot cost anything either: commitments are
   * matched against derived ones, and a wrong tree produces proofs the
   * contract rejects rather than funds it releases.
   */
  #restore(): void {
    try {
      const raw = localStorage.getItem(this.#cacheKey());
      if (!raw) return;
      const v = JSON.parse(raw) as {
        scannedTo: number;
        deposits: [number, string, number][];
        spent: string[];
      };
      if (typeof v.scannedTo !== 'number' || !Array.isArray(v.deposits)) return;
      for (const [leafIndex, commitment, timestamp] of v.deposits) {
        this.#seenDeposits.set(leafIndex, {
          commitment: BigInt(commitment),
          leafIndex,
          timestamp,
        });
      }
      for (const n of v.spent ?? []) this.#spent.add(n);
      this.#deposits = [...this.#seenDeposits.values()].sort(
        (a, b) => a.leafIndex - b.leafIndex,
      );
      this.#scannedTo = v.scannedTo;
    } catch {
      // Corrupt or unavailable storage costs a slow load, nothing more.
    }
  }

  #persist(): void {
    try {
      localStorage.setItem(
        this.#cacheKey(),
        JSON.stringify({
          scannedTo: this.#scannedTo,
          deposits: [...this.#seenDeposits.values()].map((d) => [
            d.leafIndex,
            `0x${d.commitment.toString(16)}`,
            d.timestamp,
          ]),
          spent: [...this.#spent],
        }),
      );
    } catch {
      // Quota, private browsing, disabled storage — all just mean a slow load.
    }
  }

  /** Keyed by pool and chain so a redeployment never reads the old pool's log. */
  #cacheKey(): string {
    return `strata:log:${this.#cfg.chainId}:${this.#cfg.poolAddress.toLowerCase()}`;
  }

  /**
   * Takes the log from the relayer's index, but only if the chain agrees.
   *
   * The scan it replaces is ~36 queries against a node that errors on one in
   * twelve, takes a quarter of a minute, and grows with the chain forever. All
   * of it is the same public data for every visitor.
   *
   * The index is **not trusted**. Two checks, both against the contract:
   *
   *  - the deposit count must equal `nextIndex()`, and the leaf indices must
   *    be exactly 0..n-1 with no gaps or repeats;
   *  - a merkle root rebuilt locally from the commitments must satisfy
   *    `isKnownRoot()`.
   *
   * The second is the load-bearing one. A root the contract recognises can
   * only be produced by exactly the right leaves in exactly the right order,
   * so a doctored, truncated or reordered response cannot pass — and
   * `isKnownRoot` rather than `getLastRoot` because a deposit landing between
   * the snapshot and the check would otherwise fail an honest index.
   *
   * Failure of any kind falls through to reading the chain directly. That path
   * stays maintained precisely because this one can be taken away: the relayer
   * can be down, wrong, or hostile, and the pool still works without it.
   */
  async #tryIndex(): Promise<boolean> {
    try {
      const res = await fetch(`${this.#cfg.relayerUrl}/log`);
      if (!res.ok) return false;
      const snap = (await res.json()) as {
        head: number;
        deposits: [number, string, number][];
        spent: string[];
      };
      if (!Array.isArray(snap.deposits) || typeof snap.head !== 'number') return false;

      const sorted = [...snap.deposits].sort((a, b) => a[0] - b[0]);
      const onChainCount = Number(await this.#contract.nextIndex!());
      if (sorted.length !== onChainCount) return false;
      // Contiguous from zero. A tree built over a gap still has a root; it is
      // simply not this pool's, and catching that here beats discovering it
      // when a withdrawal proof is rejected.
      if (sorted.some(([leaf], i) => leaf !== i)) return false;

      const { crypto, MerkleTree } = await import('@strata/shared/note');
      const { hashLeftRight } = await crypto();
      const commitments = sorted.map(([, c]) => BigInt(c));
      const root = new MerkleTree(20, hashLeftRight, commitments).root();
      if (!(await this.#contract.isKnownRoot!(toHex32(root)))) return false;

      for (const [leafIndex, commitment, timestamp] of sorted) {
        this.#seenDeposits.set(leafIndex, {
          commitment: BigInt(commitment),
          leafIndex,
          timestamp,
        });
      }
      for (const n of snap.spent ?? []) this.#spent.add(String(n).toLowerCase());
      this.#deposits = [...this.#seenDeposits.values()].sort(
        (a, b) => a.leafIndex - b.leafIndex,
      );
      this.#scannedTo = snap.head;
      this.#persist();
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.#restore();
    // Only worth asking when there is a cold scan to avoid. With a cache in
    // hand the tail is a couple of queries and the index saves nothing.
    if (this.#scannedTo === 0) await this.#tryIndex();
    // The interval is armed before the first read, not after it. It used to be
    // created on the line following `await this.refresh()`, so a single
    // transient RPC failure threw past it: no timer was ever set, the client
    // never tried again, and the page stayed broken until someone reloaded it.
    // Deposits are the only thing that moves the tree, so polling is enough and
    // avoids depending on websocket support from the RPC.
    this.#poll = setInterval(() => void this.refresh().catch(() => {}), 15_000);
    await this.refresh();
  }

  /**
   * Whether any read has ever succeeded.
   *
   * The UI needs this to tell "no notes" from "no idea". Without it a failed
   * read renders as a pool holding nothing — zero notes, zero ETH, and a
   * privacy warning telling the user the set is empty — which is a confident
   * statement about someone's money made from no data at all.
   */
  hasLoaded(): boolean {
    return this.#scannedTo !== 0;
  }

  stop(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    this.#listeners.clear();
  }

  /**
   * Pages a log query instead of asking for the whole chain at once.
   *
   * `queryFilter(filter, deployBlock, 'latest')` is one request whose span
   * grows with every block mined. It worked at launch and stopped working
   * around sixty thousand blocks in, when the RPC began answering `internal
   * server errror` — taking the site down with it, since a failed read left
   * the client asserting the pool was empty. A fixed window means the request
   * never gets bigger, whatever the chain does.
   */
  async #logs(filter: unknown, from: number, to: number) {
    const SPAN = 10_000;
    const out: unknown[] = [];

    // Two different failures wear the same clothes here, and treating them
    // alike is what took the site down twice.
    //
    // "Range too large" is fixed by asking for less. Rate limiting is made
    // worse by it: halving a refused request issues two more, which is exactly
    // what the endpoint was objecting to. The first version split on every
    // error, so one 429 became two, then four, and the network panel filled
    // with hundreds of requests for seventeen-block windows — an outage
    // manufactured out of a speed limit.
    //
    // So: back off and retry the same range when told to slow down, and only
    // narrow it when told it is too big.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Every field ethers might have put the status in. It reports an HTTP 429
    // as a SERVER_ERROR whose own message says "could not coalesce error",
    // with the status buried in `info` — so matching on `message` alone reads
    // a rate limit as a range problem, which is the mistake being fixed.
    const isRateLimit = (e: unknown): boolean => {
      const err = e as {
        info?: { responseStatus?: string; responseBody?: string };
        message?: string;
        shortMessage?: string;
        error?: { message?: string; code?: number };
      };
      const s = [
        err?.info?.responseStatus,
        err?.info?.responseBody,
        err?.shortMessage,
        err?.message,
        err?.error?.message,
      ]
        .filter(Boolean)
        .join(' ');
      return /\b429\b|too many requests|rate.?limit|throttl/i.test(s);
    };

    // Retry the same window; never widen the request count in response to a
    // failure. Measured against this endpoint, a 10,000-block query succeeds
    // eleven times in twelve and the failures are not size-related — 50k, 20k
    // and 9k spans all fail at about the same rate, 2k and below at none of a
    // small sample. They are the node having a bad second.
    //
    // Splitting was therefore the wrong medicine for the actual illness, and
    // an actively dangerous one: each random hiccup became two requests, then
    // four, and the burst tripped a rate limiter that answered 429, which the
    // same code read as another reason to split. One flaky response
    // manufactured hundreds of requests for seventeen-block windows and took
    // the page down harder than the hiccup ever would have.
    //
    // A plain retry costs one extra request and cannot compound.
    const take = async (a: number, b: number): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        try {
          out.push(
            ...(await this.#contract.queryFilter(
              filter as Parameters<Contract['queryFilter']>[0],
              a,
              b,
            )),
          );
          return;
        } catch (e) {
          if (attempt >= 5) throw e;
          // Longer for an explicit rate limit than for a hiccup, and jittered
          // so that several tabs backing off do not resynchronise into the
          // burst they are backing off from.
          const base = isRateLimit(e) ? 900 : 300;
          await sleep(base * 2 ** attempt + Math.random() * 250);
        }
      }
    };

    // Sequential on purpose. Four windows at a time was tried against this node
    // to shorten the cold load and made it worse — 78 seconds against 26, with
    // thirteen forced splits against four. The node is what fails under load,
    // so concurrency buys more failures, each failure buys more requests, and
    // the requests are the thing being paid for. The cold load is fixed by not
    // repeating it (see #restore) rather than by issuing it faster.
    for (let start = from; start <= to; start += SPAN) {
      await take(start, Math.min(start + SPAN - 1, to));
    }
    return out as { args: Record<string, unknown> }[];
  }

  async refresh(): Promise<void> {
    // Resolved once and reused for both queries so the two cannot disagree
    // about where "latest" is — and so #scannedTo means one definite block.
    const head = await this.#read.getBlockNumber();
    // Deposits and withdrawals are append-only, so past ranges never change
    // and only the new tail has to be fetched. The 12-block rewind is for
    // reorgs; both sets dedupe, so re-reading an event costs nothing.
    const from =
      this.#scannedTo === 0
        ? this.#cfg.deployBlock
        : Math.max(this.#cfg.deployBlock, this.#scannedTo - 12);

    if (this.#denomination === 0n) {
      this.#denomination = await this.#contract.denomination!();
    }

    const [unspent, reserveWei, events, spentEvents] = await Promise.all([
      this.#contract.unspentNotes!(),
      this.#contract.reserve!(),
      this.#logs(this.#contract.filters.Deposit!(), from, head),
      // Undirected on purpose: every burned nullifier, not the ones we care
      // about. See #spent.
      this.#logs(this.#contract.filters.Withdrawal!(), from, head),
    ]);

    const before = this.#seenDeposits.size + this.#spent.size;

    for (const e of spentEvents) {
      this.#spent.add(String(e.args.nullifierHash).toLowerCase());
    }

    for (const e of events) {
      this.#seenDeposits.set(Number(e.args.leafIndex), {
        commitment: BigInt(e.args.commitment as string),
        leafIndex: Number(e.args.leafIndex),
        timestamp: Number(e.args.timestamp),
      });
    }
    const changed = this.#seenDeposits.size + this.#spent.size !== before;
    if (changed) {
      this.#deposits = [...this.#seenDeposits.values()].sort(
        (a, b) => a.leafIndex - b.leafIndex,
      );
    }

    // Last, so a throw anywhere above leaves the window unadvanced and the
    // next poll re-reads the range rather than skipping past it.
    this.#scannedTo = head;
    // Only when the log actually grew. Serialising every deposit and nullifier
    // on each 15-second poll costs nothing at a hundred notes and is a
    // multi-megabyte stringify plus a synchronous storage write at a hundred
    // thousand — for bytes identical to the ones already there. Nothing else
    // in refresh() scales with the pool's history any more, and this would
    // have been the last thing that did.
    if (changed) this.#persist();

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

    // No request per note; that was the earlier fix and it stands. What this
    // does now is also not re-hash per note per poll — see #derived.
    const match = (
      id: string,
      nullifier: bigint,
      secret: bigint,
      commitment: bigint,
      nullifierHash: bigint,
    ): boolean => {
      const record = byCommitment.get(commitment);
      if (!record) return false;
      const spent = this.#spent.has(toHex32(nullifierHash).toLowerCase());
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

    /** Hashes only what has never been hashed before. */
    const at = (i: number) => {
      let d = this.#derived.get(i);
      if (!d) {
        const { nullifier, secret } = deriveNoteSecrets(this.#seed!, this.#cfg.poolAddress, i);
        d = {
          nullifier,
          secret,
          commitment: pedersenHash(
            concat(leInt2Buff(nullifier, 31), leInt2Buff(secret, 31)),
          ),
          nullifierHash: pedersenHash(leInt2Buff(nullifier, 31)),
        };
        this.#derived.set(i, d);
      }
      return d;
    };

    if (this.#seed) {
      // Walk indices until a run of misses; deposits are made sequentially,
      // so a gap this long means we are past the end.
      const GAP_LIMIT = 20;
      let misses = 0;
      let highest = -1;
      for (let i = 0; misses < GAP_LIMIT; i++) {
        // Yielding during the first walk only — once cached, the whole loop is
        // Map lookups and never gets near a frame budget. Without this the
        // very first scan after unlocking still froze the page for seconds,
        // which is the moment the user is most likely to be clicking.
        if (i > 0 && i % 8 === 0 && !this.#derived.has(i)) {
          await new Promise((r) => setTimeout(r, 0));
        }
        const d = at(i);
        if (match(`note-${i}`, d.nullifier, d.secret, d.commitment, d.nullifierHash)) {
          misses = 0;
          highest = i;
        } else {
          misses += 1;
        }
      }
      // One past the highest index that actually landed — not the count of
      // them. A gap anywhere in the sequence, which one failed deposit is
      // enough to produce, made the count point back at an index already on
      // chain; the next deposit then reverted on "commitment already used",
      // and did so again on every retry.
      this.#nextDerivedIndex = highest + 1;
    }

    for (const entry of noteVault.all()) {
      const nullifier = BigInt(entry.nullifier);
      const secret = BigInt(entry.secret);
      match(
        `imported-${entry.nullifier.slice(0, 12)}`,
        nullifier,
        secret,
        pedersenHash(concat(leInt2Buff(nullifier, 31), leInt2Buff(secret, 31))),
        pedersenHash(leInt2Buff(nullifier, 31)),
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
    // From the locally-held set rather than a targeted isSpent call. Asking the
    // RPC about this particular hash would announce that whoever just received
    // this note is now holding it — the off-chain handoff the interface
    // describes as unobservable.
    if (this.#spent.has(toHex32(nullifierHash).toLowerCase())) {
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

  async deposit(req: DepositRequest, onStep: (i: number) => void): Promise<DepositReceipt> {
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
      const { nullifier, secret } = deriveNoteSecrets(
        this.#seed,
        this.#cfg.poolAddress,
        startIndex + i,
      );
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
    const hashes: string[] = [];
    for (const commitment of commitments) {
      const tx = await writable.deposit!(toHex32(commitment), {
        value: this.#denomination,
      });
      await tx.wait();
      hashes.push(tx.hash);
    }

    onStep(3);
    await this.refresh();
    return { notes: split.totalNotes, amount: split.coveredAmount, hashes };
  }

  async withdraw(req: WithdrawRequest, onStep: (i: number) => void): Promise<WithdrawReceipt> {
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
    const hashes: string[] = [];
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
      const { txHash } = await res.json().catch(() => ({ txHash: undefined }));
      if (txHash) hashes.push(txHash);

      onStep(2);
    }

    onStep(3);
    await this.refresh();
    return {
      notes: count,
      recipient: req.recipient,
      received: this.quoteWithdrawal(req.amount).net,
      hashes,
    };
  }

  /** Exposed so the UI can pre-download the proving key while the user reads. */
  /**
   * Pre-fetches the proving key.
   *
   * Called when the Withdraw tab opens rather than at withdrawal time. It was
   * never called at all, so the 20 MB fetch fired inside prove(): to anyone
   * watching the connection, a large transfer followed seconds later by a small
   * POST and then an on-chain withdrawal is an unmistakable, precisely-timed
   * announcement of intent. Fetching it while the user is still reading
   * separates the two.
   */
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
