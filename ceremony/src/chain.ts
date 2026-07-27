import { open } from 'node:fs/promises';
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
 *
 * The contribution *count* is read from the key itself, never from the log.
 * That is not belt-and-braces: contributors choose their own name, snarkjs
 * interpolates it into the log title verbatim, and a name containing a newline
 * pushes the title's colon onto the next line so the entry fails to parse and
 * is skipped. An upload with two new contributions then reads as one, passes
 * the prefix check, and is accepted — after which the key and the transcript
 * disagree, every later upload fails the contiguity check, and the ceremony is
 * wedged for everyone with no error that names the cause. A restart does not
 * notice, because both sides skip the same entry.
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
 * The number of contributions, read from the key's own MPC section.
 *
 * A zkey is a section table: magic, version, section count, then (id, length,
 * data) triples. Section 10 holds the phase-2 parameters and opens with a
 * 64-byte cs hash followed by a little-endian u32 count. Nothing here parses
 * text, so nothing here can be influenced by what a contributor calls
 * themselves.
 */
async function trueContributionCount(zkeyPath: string): Promise<number> {
  const fd = await open(zkeyPath, 'r');
  try {
    const head = Buffer.alloc(12);
    await fd.read(head, 0, 12, 0);
    if (head.subarray(0, 4).toString('latin1') !== 'zkey') {
      throw new Error('not a zkey file');
    }
    const sections = head.readUInt32LE(8);

    let at = 12;
    const entry = Buffer.alloc(12);
    for (let i = 0; i < sections; i++) {
      await fd.read(entry, 0, 12, at);
      const id = entry.readUInt32LE(0);
      const length = Number(entry.readBigUInt64LE(4));
      const start = at + 12;
      if (id === 10) {
        const count = Buffer.alloc(4);
        await fd.read(count, 0, 4, start + 64);
        return count.readUInt32LE(0);
      }
      at = start + length;
    }
    throw new Error('the key has no phase-2 section');
  } finally {
    await fd.close();
  }
}

/**
 * Verifies a key and reports its contribution chain.
 *
 * Names and hashes come from snarkjs's logger, because it exposes no API for
 * them. The *count* does not — it is read from the file, and a disagreement
 * between the two is fatal. That is what stops a contributor from choosing a
 * name that makes their own entry unparseable and therefore invisible.
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

    // [\s\S] rather than . so a newline inside the contributor-chosen name
    // cannot push the colon out of reach and make the entry vanish.
    const contribution = /^contribution #(\d+)\s+([\s\S]*?):\s*([\s\S]*)$/i.exec(
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

  // The log said one thing; the file says another. Whichever is right, the
  // parser is not to be trusted with the count, and accepting the difference
  // is what desynchronises the key from the transcript.
  const actual = await trueContributionCount(zkeyPath);
  if (actual !== contributions.length) {
    throw new Error(
      `the key holds ${actual} contributions but only ${contributions.length} ` +
        'could be read from the verification log — refusing it. A contribution ' +
        'name containing a newline does this.',
    );
  }

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
