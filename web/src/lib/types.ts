/**
 * Domain types for the Strata privacy pool.
 *
 * Everything here describes the *protocol*, not the mock. The mock in
 * `mockPool.ts` and the eventual on-chain client both produce these shapes,
 * so swapping one for the other should not touch any component.
 */

/**
 * A pool's note size, in ETH.
 *
 * Not a fixed set. Each PrivacyPool has exactly one denomination, immutable
 * from deployment — "more denominations" means more contracts, not more tiers
 * inside one. A hardcoded union here was wrong twice over: it broke when a
 * pool deployed at 0.01 (the interface silently fell back to 0.1 and quoted
 * users ten times the real amount), and it implied the contract knows about
 * sizes it has never heard of.
 */
export type Denomination = number;

/**
 * Sizes we intend to run pools at, purely for the interface's roadmap table.
 *
 * These are a plan, not a contract feature. Nothing on-chain unlocks them —
 * each one requires deploying another pool with its own, separate anonymity
 * set. The UI has to say that rather than implying an automatic threshold.
 */
export const PLANNED_DENOMINATIONS: readonly number[] = [0.01, 0.1, 1, 10];

/**
 * Fee split. These are `immutable` constants in the contract — the frontend
 * mirrors them so it can show the breakdown without an RPC call, but the
 * contract is the source of truth.
 */
export const FEE = {
  /** Total withdrawal fee, basis points. */
  TOTAL_BPS: 30,
  /** Paid atomically to the relayer address named in the proof. */
  RELAYER_BPS: 20,
  /** Accrues in the pool reserve. The contract has no function to take it out. */
  RESERVE_BPS: 10,
} as const;

export interface DenomTier {
  value: Denomination;
  /** Whether deposits are currently accepted at this denomination. */
  open: boolean;
  /**
   * Unspent notes required in the tier below before this one opens.
   * Opening a tier early splits the anonymity set across two pools that
   * cannot protect each other.
   */
  unlockThreshold: number;
  /** Live count of unspent commitments at this denomination. */
  unspentNotes: number;
  /** Total ETH currently backing unspent notes at this denomination. */
  ethLocked: number;
}

export interface PoolState {
  chainId: number;
  tiers: DenomTier[];
  /** Sum of unspent commitments across all open tiers. */
  totalUnspentNotes: number;
  totalEthInPool: number;
  /** The accrued 0.1%. No withdrawal function exists for this. */
  reserveEth: number;
  uniqueDepositors: number;
  /** Weekly reserve growth, oldest first. Used by the bar chart. */
  reserveHistory: number[];
  avgNoteAgeDays: number;
  anonSetGrowth30d: number;
}

/** A note is a bearer instrument: whoever knows its secrets can spend it. */
export interface Note {
  id: string;
  denomination: Denomination;
  /** Position in the Merkle tree. Monotonic with deposit time. */
  leafIndex: number;
  createdAt: number;
  spent: boolean;
}

export type PrivacyTier = 'critical' | 'thin' | 'ok' | 'strong';

/**
 * How exposed a withdrawal would be right now.
 *
 * During cold start this object's job is to *talk the user out of* withdrawing,
 * not to reassure them. A UI that shows "protected" at an anonymity set of six
 * causes real losses.
 */
export interface PrivacyAssessment {
  score: number;
  tier: PrivacyTier;
  /**
   * Notes that could plausibly be yours.
   *
   * This is NOT the total unspent count. Notes deposited *after* the one you
   * are about to spend cannot be yours, so an observer excludes them — and so
   * must we, or we overstate the protection.
   */
  effectiveAnonSet: number;
  headline: string;
  detail: string;
  /** Null when waiting no longer meaningfully helps. */
  suggestedWaitHours: number | null;
  scoreAfterWait: number | null;
  /** Whether the withdraw button should require a second confirmation. */
  requiresConfirmation: boolean;
}

/** How an amount decomposes into notes at the currently open denominations. */
export interface Split {
  parts: { denomination: Denomination; count: number }[];
  totalNotes: number;
  /** What actually gets deposited. May be less than requested — see `remainder`. */
  coveredAmount: number;
  /**
   * The part of the requested amount that cannot be expressed in open
   * denominations. Fixed denominations trade exact amounts for privacy;
   * the UI must surface this at input time, not at confirmation time.
   */
  remainder: number;
}

export interface TxStep {
  label: string;
  state: 'idle' | 'active' | 'done';
}

export interface DepositRequest {
  amount: number;
}

export interface WithdrawRequest {
  recipient: string;
  amount: number;
}

export interface FeeBreakdown {
  gross: number;
  relayerFee: number;
  reserveFee: number;
  net: number;
}

export type ImportResult =
  | { ok: true; denomination: number }
  | { ok: false; reason: string };

export interface PoolClient {
  getState(): PoolState;
  subscribe(listener: (state: PoolState) => void): () => void;
  getNotes(): Note[];
  /** Sum of unspent notes, i.e. what the UI calls "private balance". */
  getBalance(): number;
  splitAmount(amount: number): Split;
  quoteWithdrawal(amount: number): FeeBreakdown;
  /**
   * The assessment is about the pool and the age of the oldest note held, not
   * about an amount. The signature said otherwise and both implementations
   * ignored the argument, so a caller passing one was silently doing nothing.
   */
  assessPrivacy(): PrivacyAssessment;
  estimateDepositGas(noteCount: number): number;
  deposit(req: DepositRequest, onStep: (i: number) => void): Promise<void>;
  withdraw(req: WithdrawRequest, onStep: (i: number) => void): Promise<void>;

  /**
   * Serialised notes, for handing to someone else.
   *
   * Whoever holds one of these strings can spend the note — including you,
   * after you have given it away. The transfer is not atomic and the UI has
   * to say so.
   */
  exportNotes(ids: string[]): Promise<{ id: string; encoded: string }[]>;

  /** Accepts a note string. Verified against the chain before it is stored. */
  importNote(encoded: string): Promise<ImportResult>;

  /**
   * Pre-fetches the proving key, if this client needs one.
   *
   * Optional because the simulated pool proves nothing. On the live client it
   * separates the 20 MB download from the withdrawal it would otherwise
   * announce.
   */
  warmUpProver?(onProgress?: (p: { loaded: number; total: number }) => void): Promise<void>;
}
