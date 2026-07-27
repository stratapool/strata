import type { Contract } from 'ethers';

/**
 * Serves the pool's public logs so a visitor does not have to rebuild them.
 *
 * Every client was walking the whole Deposit and Withdrawal history from the
 * deployment block — about thirty-six log queries against a node that answers
 * one in twelve with an error, taking a quarter of a minute, and getting worse
 * with every block mined. Nothing about that work is per-visitor: it is the
 * same public data for everyone, so it is done once here.
 *
 * **This service is not trusted, and the client must not treat it as if it
 * were.** What it returns is checked against the chain before use: the deposit
 * count against `nextIndex()`, and — the load-bearing one — a merkle root
 * rebuilt from the returned commitments against `isKnownRoot()`. A root that
 * the contract recognises can only come from exactly the right leaves in
 * exactly the right order, so a doctored, truncated or reordered response
 * fails to verify and the client falls back to reading the chain itself.
 *
 * Even without that check the damage would be bounded: commitments are matched
 * against ones the wallet derives locally, so this cannot tell a visitor a note
 * is theirs, and a wrong tree yields proofs the contract rejects rather than
 * funds it releases. The check exists so that "bounded" does not have to be the
 * argument.
 *
 * Withdrawal nullifiers are included for the same reason the client fetches
 * them in bulk rather than asking about its own: asking narrows the set of
 * notes a server can attribute to you, and this server already sees your
 * withdrawals.
 */
export interface LogSnapshot {
  /** Block the snapshot is complete through. */
  head: number;
  deployBlock: number;
  /** [leafIndex, commitment, timestamp], ascending by leafIndex. */
  deposits: [number, string, number][];
  /** Every burned nullifier hash, lowercased. Undirected by design. */
  spent: string[];
}

/** Matches the client's window. The upstream refuses anything wider. */
const SPAN = 10_000;

export class LogIndex {
  readonly #contract: Contract;
  readonly #deployBlock: number;
  /** leafIndex -> record, so an overlapping re-read cannot duplicate. */
  readonly #deposits = new Map<number, [number, string, number]>();
  readonly #spent = new Set<string>();
  #scannedTo = 0;
  #refreshing: Promise<void> | null = null;

  constructor(contract: Contract, deployBlock: number) {
    this.#contract = contract;
    this.#deployBlock = deployBlock;
  }

  snapshot(): LogSnapshot {
    return {
      head: this.#scannedTo,
      deployBlock: this.#deployBlock,
      deposits: [...this.#deposits.values()].sort((a, b) => a[0] - b[0]),
      spent: [...this.#spent],
    };
  }

  get ready(): boolean {
    return this.#scannedTo !== 0;
  }

  /**
   * Collapses concurrent callers onto one scan.
   *
   * Without this, N simultaneous page loads on a cold start each launch their
   * own full history walk against the same upstream — the stampede that the
   * whole index exists to prevent, moved one layer inward.
   */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#run().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #run(): Promise<void> {
    const head = await this.#contract.runner!.provider!.getBlockNumber();
    // Append-only logs: past ranges never change, so only the tail is read.
    // The rewind is for reorgs; both collections dedupe.
    const from =
      this.#scannedTo === 0
        ? this.#deployBlock
        : Math.max(this.#deployBlock, this.#scannedTo - 12);

    for (let start = from; start <= head; start += SPAN) {
      const end = Math.min(start + SPAN - 1, head);
      const [deposits, spent] = await Promise.all([
        this.#query(this.#contract.filters.Deposit!(), start, end),
        this.#query(this.#contract.filters.Withdrawal!(), start, end),
      ]);
      for (const e of deposits) {
        this.#deposits.set(Number(e.args.leafIndex), [
          Number(e.args.leafIndex),
          String(e.args.commitment).toLowerCase(),
          Number(e.args.timestamp),
        ]);
      }
      for (const e of spent) {
        this.#spent.add(String(e.args.nullifierHash).toLowerCase());
      }
    }

    // Last, so a throw above leaves the window unadvanced and the next attempt
    // re-reads the range instead of skipping past it.
    this.#scannedTo = head;
  }

  /**
   * Retries the same window; never splits it.
   *
   * Splitting on failure was tried in the client and did real damage. The
   * failures here are not size-related — a 10k query succeeds eleven times in
   * twelve at every width tested — so halving a refused request just issues
   * two more, which trips the rate limit, which reads as another reason to
   * split. One flaky response becomes hundreds.
   */
  async #query(
    filter: unknown,
    from: number,
    to: number,
  ): Promise<{ args: Record<string, unknown> }[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.#contract.queryFilter(
          filter as Parameters<Contract['queryFilter']>[0],
          from,
          to,
        )) as unknown as { args: Record<string, unknown> }[];
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 200));
      }
    }
  }
}
