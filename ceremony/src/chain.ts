import * as snarkjs from 'snarkjs';

/**
 * Reading and checking the contribution chain inside a phase-2 key.
 *
 * This is the only part of the coordinator that can lose a contribution
 * silently, so it is the part worth being paranoid about.
 *
 * `zkey verify` answers "is this a valid key whose contribution chain is
 * internally consistent" — and nothing else. In particular it happily accepts a
 * key built by taking contribution #3, adding one on top, and calling the
 * result #4: that chain is perfectly valid, it just quietly discards everybody
 * who contributed between. Whoever did it would then be the last contributor in
 * a chain of four instead of twenty, and every participant after #3 would have
 * been erased without a single error anywhere.
 *
 * So validity is necessary and not sufficient. The coordinator additionally
 * requires that the transcript it already published is a *prefix* of what was
 * uploaded, with exactly one entry added.
 */

export interface Contribution {
  index: number;
  name: string;
  /** blake2b of the contribution, lowercase hex, whitespace stripped. */
  hash: string;
}

export interface ChainReport {
  valid: boolean;
  circuitHash: string | null;
  contributions: Contribution[];
}

const normaliseHash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/**
 * snarkjs has no API for listing contributions — the CLI prints them — so they
 * are recovered from the logger it accepts. Fragile by nature, which is why
 * `readChain` refuses a result it cannot fully account for rather than
 * returning a partial list: a parser that silently drops an entry here would
 * defeat the prefix check it exists to feed.
 */
export async function readChain(
  zkeyPath: string,
  r1csPath: string,
  ptauPath: string,
): Promise<ChainReport> {
  const messages: string[] = [];
  const capture = (m: unknown) => messages.push(String(m));
  const logger: snarkjs.SnarkjsLogger = {
    info: capture,
    warn: capture,
    error: capture,
    log: capture,
    debug: () => {},
  };

  const valid = await snarkjs.zKey.verifyFromR1cs(
    r1csPath,
    ptauPath,
    zkeyPath,
    logger,
  );

  let circuitHash: string | null = null;
  const contributions: Contribution[] = [];

  for (const message of messages) {
    const circuit = /^circuit hash:\s*([\s\S]*)$/i.exec(message.trim());
    if (circuit?.[1]) {
      circuitHash ??= normaliseHash(circuit[1]);
      continue;
    }

    const contribution = /^contribution #(\d+)\s*(.*?):\s*([\s\S]*)$/i.exec(
      message.trim(),
    );
    if (!contribution) continue;

    const [, rawIndex, rawName, rawHash] = contribution;
    const hash = normaliseHash(rawHash ?? '');
    // A contribution whose hash did not parse is worse than no contribution:
    // it would compare unequal to itself on the next round and stall the
    // ceremony, or compare equal to another empty one and mask a fork.
    if (!/^[0-9a-f]{32,}$/.test(hash)) {
      throw new Error(
        `could not parse the hash of contribution #${rawIndex} — refusing to ` +
          'report a chain that may be missing entries',
      );
    }
    contributions.push({
      index: Number(rawIndex),
      name: (rawName ?? '').trim(),
      hash,
    });
  }

  // snarkjs reports them in order; depending on that silently would be a
  // needless assumption when the prefix check downstream relies on it.
  contributions.sort((a, b) => a.index - b.index);
  contributions.forEach((c, i) => {
    if (c.index !== i + 1) {
      throw new Error(
        `contribution numbering is not contiguous: expected #${i + 1}, saw #${c.index}`,
      );
    }
  });

  return { valid, circuitHash, contributions };
}

export type ExtendResult =
  | { ok: true; added: Contribution }
  | { ok: false; reason: string };

/**
 * Whether `next` is `previous` plus exactly one new contribution.
 *
 * Both halves matter. A shorter or equal chain means nothing was added. A
 * longer one means somebody batched contributions, which is not necessarily
 * malicious but is not what the slot was handed out for, and accepting it would
 * let one participant occupy several places in a transcript that is supposed to
 * name distinct people.
 */
export function extendsChain(
  previous: readonly Contribution[],
  next: readonly Contribution[],
): ExtendResult {
  if (next.length !== previous.length + 1) {
    return {
      ok: false,
      reason:
        `expected exactly one new contribution: the chain had ${previous.length}, ` +
        `the upload has ${next.length}`,
    };
  }

  for (let i = 0; i < previous.length; i++) {
    const before = previous[i]!;
    const after = next[i]!;
    if (before.hash !== after.hash) {
      return {
        ok: false,
        reason:
          `contribution #${i + 1} does not match the published transcript — the ` +
          'upload forks the chain and would erase everyone after it',
      };
    }
  }

  return { ok: true, added: next[next.length - 1]! };
}
