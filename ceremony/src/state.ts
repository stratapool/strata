import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Contribution } from './chain.js';

/**
 * The ceremony's durable state: the transcript, and the one slot.
 *
 * Everything here is written before it is announced. A contribution that has
 * been accepted into the chain but not yet recorded would be invisible to the
 * next prefix check, which would then reject every subsequent upload — the
 * ceremony would appear to break for everyone else because of one crash at the
 * wrong moment.
 */

export interface RecordedContribution extends Contribution {
  /** Whatever the contributor asked to be called. Optional, and only a label. */
  displayName: string | null;
  /** Optional, for a future airdrop. Nothing is promised by recording it. */
  address: string | null;
  /** SHA-256 of the zkey this contribution produced, so it can be checked. */
  zkeySha256: string;
  at: string;
}

export interface Attestation {
  address: string | null;
  handle: string | null;
  /** The zkey the verifier says they checked. */
  zkeySha256: string;
  contributionCount: number;
  at: string;
}

export interface Transcript {
  circuitHash: string | null;
  startedAt: string | null;
  drandRound: number | null;
  contributions: RecordedContribution[];
  attestations: Attestation[];
  finalised: { beaconRound: number; randomness: string; at: string } | null;
}

const EMPTY: Transcript = {
  circuitHash: null,
  startedAt: null,
  drandRound: null,
  contributions: [],
  attestations: [],
  finalised: null,
};

export interface Slot {
  token: string;
  claimedAt: number;
  expiresAt: number;
  /** SHA-256 of the zkey handed out, so a stale upload is caught. */
  baseSha256: string;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export class CeremonyState {
  #dir: string;
  #transcript: Transcript = structuredClone(EMPTY);
  #slot: Slot | null = null;
  /**
   * Set while an upload is being verified, which takes about ten seconds.
   *
   * The slot alone does not cover this. Node serves other requests during those
   * ten seconds, so without a second flag the same token could be replayed
   * concurrently and two verifications would race to replace the chain — the
   * loser's contribution silently discarded, with a success returned for it.
   */
  #busy = false;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get transcriptPath() { return path.join(this.#dir, 'transcript.json'); }
  get currentZkeyPath() { return path.join(this.#dir, 'current.zkey'); }
  get uploadsDir() { return path.join(this.#dir, 'uploads'); }

  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
    try {
      this.#transcript = {
        ...structuredClone(EMPTY),
        ...JSON.parse(await readFile(this.transcriptPath, 'utf8')),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await this.#persist();
    }
  }

  async #persist(): Promise<void> {
    // Write beside the target and rename: a torn transcript is unrecoverable,
    // because the prefix check has nothing else to compare an upload against.
    const tmp = `${this.transcriptPath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#transcript, null, 2));
    await rename(tmp, this.transcriptPath);
  }

  transcript(): Transcript { return structuredClone(this.#transcript); }
  contributions(): RecordedContribution[] { return this.#transcript.contributions; }
  count(): number { return this.#transcript.contributions.length; }
  isBusy(): boolean { return this.#busy; }
  isFinalised(): boolean { return this.#transcript.finalised !== null; }

  async begin(circuitHash: string | null, drandRound: number | null): Promise<void> {
    this.#transcript.circuitHash ??= circuitHash;
    this.#transcript.startedAt ??= new Date().toISOString();

    // The announced round can be moved while it is still in the future, and
    // only then. The property being protected is that the value does not exist
    // when it is named — a round already published could have been picked for
    // its value, which is the whole thing announcing one in advance prevents.
    // Shortening the window costs contributions, not soundness.
    if (drandRound !== null && drandRound !== this.#transcript.drandRound) {
      const previous = this.#transcript.drandRound;
      this.#transcript.drandRound = drandRound;
      if (previous !== null) {
        console.warn(
          `
⚠ announced beacon round moved: ${previous} → ${drandRound}.` +
            `
  Sound only because ${drandRound} has not been published yet.` +
            `
  Say so publicly — silently changing it reads as picking one.
`,
        );
      }
    }
    await this.#persist();
  }

  // ------------------------------------------------------------------ slot --

  /** The live slot, or null. Expiry is evaluated here so nothing has to poll. */
  slot(now = Date.now()): Slot | null {
    if (this.#slot && this.#slot.expiresAt <= now) this.#slot = null;
    return this.#slot;
  }

  claimSlot(baseSha256: string, ttlSeconds: number, now = Date.now()): Slot | null {
    if (this.slot(now)) return null;
    this.#slot = {
      token: randomBytes(24).toString('hex'),
      claimedAt: now,
      expiresAt: now + ttlSeconds * 1000,
      baseSha256,
    };
    return this.#slot;
  }

  releaseSlot(): void { this.#slot = null; }

  /**
   * Claims the right to verify an upload.
   *
   * Returns false when the token is wrong, expired, or a verification is
   * already running. The caller must call `endUpload` in a finally block —
   * leaving the flag set would wedge the ceremony until a restart.
   */
  beginUpload(token: string, now = Date.now()): boolean {
    const slot = this.slot(now);
    if (!slot || slot.token !== token || this.#busy) return false;
    this.#busy = true;
    return true;
  }

  endUpload(): void { this.#busy = false; }

  // ---------------------------------------------------------------- record --

  async accept(
    contribution: Contribution,
    meta: { displayName: string | null; address: string | null },
    verifiedZkey: string,
  ): Promise<RecordedContribution> {
    const zkeySha256 = await sha256File(verifiedZkey);
    const record: RecordedContribution = {
      ...contribution,
      displayName: meta.displayName,
      address: meta.address,
      zkeySha256,
      at: new Date().toISOString(),
    };

    // The chain moves first. If the process dies between these two lines the
    // transcript is one behind, which the next prefix check reports as a
    // mismatch — loud and fixable. The reverse order loses the key itself.
    await rename(verifiedZkey, this.currentZkeyPath);
    this.#transcript.contributions.push(record);
    await this.#persist();
    this.releaseSlot();
    return record;
  }

  async attest(a: Omit<Attestation, 'at'>): Promise<void> {
    this.#transcript.attestations.push({ ...a, at: new Date().toISOString() });
    await this.#persist();
  }

  async finalise(beaconRound: number, randomness: string): Promise<void> {
    this.#transcript.finalised = {
      beaconRound,
      randomness,
      at: new Date().toISOString(),
    };
    await this.#persist();
  }

  async discardUpload(file: string): Promise<void> {
    await rm(file, { force: true });
  }
}
