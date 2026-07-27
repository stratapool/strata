import { assess } from './privacy';
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

/**
 * Scenarios exist so the cold-start states are reviewable.
 *
 * A mock that only ever renders a mature pool hides exactly the states the
 * product spends its first months in — and those are the states where the UI
 * has to do the hardest thing, which is tell the user not to withdraw yet.
 *
 * Select with `?scenario=launch|early|mature`.
 */
export type Scenario = 'launch' | 'early' | 'mature';

interface Seed {
  unspentNotes: number;
  uniqueDepositors: number;
  reserveEth: number;
  avgNoteAgeDays: number;
  anonSetGrowth30d: number;
  /** Notes added per tick. Drives the "live" feel. */
  growthPerTick: number;
  userNotes: number;
}

const SEEDS: Record<Scenario, Seed> = {
  // Day one. This is what the product actually looks like at launch.
  launch: {
    unspentNotes: 14,
    uniqueDepositors: 6,
    reserveEth: 0.0021,
    avgNoteAgeDays: 0.4,
    anonSetGrowth30d: 0,
    growthPerTick: 0.35,
    userNotes: 3,
  },
  // A few weeks in. Real but thin.
  early: {
    unspentNotes: 640,
    uniqueDepositors: 214,
    reserveEth: 0.19,
    avgNoteAgeDays: 3.1,
    anonSetGrowth30d: 210.5,
    growthPerTick: 1.2,
    userNotes: 8,
  },
  // The state the original design mocked up.
  mature: {
    unspentNotes: 12847,
    uniqueDepositors: 6120,
    reserveEth: 18.64,
    avgNoteAgeDays: 9.2,
    anonSetGrowth30d: 38.4,
    growthPerTick: 2.2,
    userNotes: 56,
  },
};

const LAUNCH_DENOM: Denomination = 0.1;
/**
 * Simulation only. The real contract has no unlock mechanism — a larger
 * denomination means deploying another pool — so these thresholds describe
 * the plan, not anything the chain enforces.
 */
const UNLOCK_THRESHOLDS = new Map<number, number>([
  [0.01, 0],
  [0.1, 0],
  [1, 2000],
  [10, 5000],
]);
const thresholdFor = (d: number): number => UNLOCK_THRESHOLDS.get(d) ?? 5000;

export function resolveScenario(search: string): Scenario {
  const v = new URLSearchParams(search).get('scenario');
  if (v === 'launch' || v === 'early' || v === 'mature') return v;
  return 'early';
}

export class MockPool implements PoolClient {
  private listeners = new Set<(s: PoolState) => void>();
  private state: PoolState;
  private notes: Note[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private seed: Seed;

  constructor(scenario: Scenario) {
    this.seed = SEEDS[scenario];
    this.notes = this.makeUserNotes(this.seed.userNotes);
    this.state = this.buildState(this.seed.unspentNotes);
    this.start();
  }

  private makeUserNotes(n: number): Note[] {
    const now = Date.now();
    return Array.from({ length: n }, (_, i) => ({
      id: `note-${i}`,
      denomination: LAUNCH_DENOM,
      leafIndex: i * 7 + 3,
      // Spread the user's notes over the last few days.
      createdAt: now - (i + 1) * 5.5 * 3600 * 1000,
      spent: false,
    }));
  }

  private buildState(unspent: number): PoolState {
    const tiers: DenomTier[] = PLANNED_DENOMINATIONS.map((d) => {
      const open = d === LAUNCH_DENOM || unspent >= thresholdFor(d);
      const notes = d === LAUNCH_DENOM ? unspent : 0;
      return {
        value: d,
        open,
        unlockThreshold: thresholdFor(d),
        unspentNotes: notes,
        ethLocked: notes * d,
      };
    });

    const totalEth = tiers.reduce((a, t) => a + t.ethLocked, 0);
    const history = Array.from({ length: 12 }, (_, i) =>
      Number((this.seed.reserveEth * ((i + 1) / 12) ** 1.8).toFixed(4)),
    );

    return {
      chainId: 4663,
      tiers,
      totalUnspentNotes: unspent,
      totalEthInPool: totalEth,
      reserveEth: this.seed.reserveEth,
      uniqueDepositors: this.seed.uniqueDepositors,
      reserveHistory: history,
      avgNoteAgeDays: this.seed.avgNoteAgeDays,
      anonSetGrowth30d: this.seed.anonSetGrowth30d,
    };
  }

  private start(): void {
    this.timer = setInterval(() => {
      const add = Math.random() < this.seed.growthPerTick % 1 ? 1 : 0;
      const grow = Math.floor(this.seed.growthPerTick) + add;
      if (grow > 0) {
        this.state = this.buildState(this.state.totalUnspentNotes + grow);
        this.state.reserveEth = Number(
          (this.seed.reserveEth + Math.random() * 0.0004).toFixed(5),
        );
        this.emit();
      }
    }, 2600);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }

  getState(): PoolState {
    return this.state;
  }

  subscribe(listener: (s: PoolState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getNotes(): Note[] {
    return this.notes.filter((n) => !n.spent);
  }

  getBalance(): number {
    return this.getNotes().reduce((a, n) => a + n.denomination, 0);
  }

  private openDenominations(): Denomination[] {
    return this.state.tiers
      .filter((t) => t.open)
      .map((t) => t.value)
      .sort((a, b) => b - a);
  }

  splitAmount(amount: number): Split {
    const open = this.openDenominations();
    const smallest = open[open.length - 1] ?? LAUNCH_DENOM;
    // Work in units of the smallest open denomination to dodge float drift.
    const unit = smallest;
    let remainingUnits = Math.floor(
      Number((Math.max(0, amount) / unit).toFixed(6)),
    );

    const parts: Split['parts'] = [];
    for (const d of open) {
      const perNote = Math.round(d / unit);
      const n = Math.floor(remainingUnits / perNote);
      if (n > 0) {
        parts.push({ denomination: d, count: n });
        remainingUnits -= n * perNote;
      }
    }

    const covered = Number(
      (parts.reduce((a, p) => a + p.denomination * p.count, 0)).toFixed(6),
    );
    return {
      parts,
      totalNotes: parts.reduce((a, p) => a + p.count, 0),
      coveredAmount: covered,
      remainder: Number((Math.max(0, amount) - covered).toFixed(6)),
    };
  }

  quoteWithdrawal(amount: number): FeeBreakdown {
    const relayerFee = (amount * FEE.RELAYER_BPS) / 10000;
    const reserveFee = (amount * FEE.RESERVE_BPS) / 10000;
    return {
      gross: amount,
      relayerFee,
      reserveFee,
      net: amount - relayerFee - reserveFee,
    };
  }

  /**
   * Effective anonymity set for the oldest note the user would spend.
   *
   * Notes deposited after that one cannot be the source of this withdrawal, so
   * an observer discards them. Reporting the raw unspent count instead would
   * overstate protection — badly, in a fast-growing pool.
   */
  assessPrivacy(): PrivacyAssessment {
    const mine = this.getNotes();
    const oldest = mine.reduce<Note | null>(
      (a, n) => (a === null || n.createdAt < a.createdAt ? n : a),
      null,
    );
    if (!oldest) {
      return assess(this.state.totalUnspentNotes, 0);
    }
    const ageHours = (Date.now() - oldest.createdAt) / 3600_000;
    // Approximate the pre-existing population from the note's tree position.
    const before = Math.min(this.state.totalUnspentNotes, oldest.leafIndex + 1);
    const effective = Math.max(1, before);
    return assess(effective, ageHours);
  }

  estimateDepositGas(noteCount: number): number {
    // Measured on Robinhood Chain: gasPrice ~0.062 gwei, a Poseidon-based
    // Merkle insert lands around 340k gas per deposit.
    return Number((0.000058 * Math.max(1, noteCount)).toFixed(6));
  }

  async deposit(req: DepositRequest, onStep: (i: number) => void): Promise<DepositReceipt> {
    const split = this.splitAmount(req.amount);
    for (let i = 0; i < 4; i++) {
      onStep(i);
      await delay(900);
    }
    const now = Date.now();
    const base = this.notes.length;
    for (let i = 0; i < split.totalNotes; i++) {
      this.notes.push({
        id: `note-${base + i}`,
        denomination: LAUNCH_DENOM,
        leafIndex: this.state.totalUnspentNotes + i,
        createdAt: now,
        spent: false,
      });
    }
    this.state = this.buildState(
      this.state.totalUnspentNotes + split.totalNotes,
    );
    this.emit();
    // No hashes: the simulated pool never touched a chain, and inventing
    // plausible ones would put strings in the confirmation panel that look
    // exactly like something you could go and check.
    return { notes: split.totalNotes, amount: split.coveredAmount, hashes: [] };
  }

  /**
   * Structurally identical to a real note string so the export UI can be
   * exercised, but derived from the note id — these are not secrets and the
   * simulated pool has nothing to protect.
   */
  async exportNotes(ids: string[]): Promise<{ id: string; encoded: string }[]> {
    return ids
      .filter((id) => this.notes.some((n) => n.id === id && !n.spent))
      .map((id) => {
        let h = 0;
        for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        const hex = Array.from({ length: 124 }, (_, i) =>
          (((h + i * 7) % 16) >>> 0).toString(16),
        ).join('');
        return { id, encoded: `strata-note-v1-${hex}` };
      });
  }

  async importNote(encoded: string): Promise<
    { ok: true; denomination: number } | { ok: false; reason: string }
  > {
    await delay(400);
    if (!/^strata-note-v1-[0-9a-f]{124}$/.test(encoded.trim())) {
      return { ok: false, reason: 'That does not look like a Strata note.' };
    }
    const now = Date.now();
    this.notes.push({
      id: `imported-${this.notes.length}`,
      denomination: LAUNCH_DENOM,
      leafIndex: this.state.totalUnspentNotes,
      createdAt: now,
      spent: false,
    });
    this.state = this.buildState(this.state.totalUnspentNotes + 1);
    this.emit();
    return { ok: true, denomination: LAUNCH_DENOM };
  }

  async withdraw(
    req: WithdrawRequest,
    onStep: (i: number) => void,
  ): Promise<WithdrawReceipt> {
    for (let i = 0; i < 4; i++) {
      onStep(i);
      await delay(900);
    }
    let toSpend = Math.round(req.amount / LAUNCH_DENOM);
    for (const n of this.notes) {
      if (toSpend <= 0) break;
      if (!n.spent) {
        n.spent = true;
        toSpend--;
      }
    }
    const spent = Math.round(req.amount / LAUNCH_DENOM);
    this.state = this.buildState(
      Math.max(0, this.state.totalUnspentNotes - spent),
    );
    this.state.reserveEth = Number(
      (this.state.reserveEth + (req.amount * FEE.RESERVE_BPS) / 10000).toFixed(5),
    );
    this.emit();
    return {
      notes: spent,
      recipient: req.recipient,
      received: this.quoteWithdrawal(req.amount).net,
      hashes: [],
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
