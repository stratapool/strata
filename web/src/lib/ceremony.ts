/**
 * Client for the phase-2 ceremony coordinator.
 *
 * The contribution runs here, in the page. That is not a convenience: the
 * whole security property is that each participant generates randomness that
 * nobody else ever sees and then discards it. A server that produced the
 * randomness on a contributor's behalf would hold every secret in the chain,
 * and the ceremony would prove nothing at all.
 */

export interface CeremonyStatus {
  contributions: number;
  circuitHash: string | null;
  startedAt: string | null;
  drandRound: number | null;
  finalised: { beaconRound: number; randomness: string; at: string } | null;
  slotOpen: boolean;
  busy: boolean;
  slotExpiresAt: string | null;
}

export interface ContributionRecord {
  index: number;
  name: string;
  hash: string;
  displayName: string | null;
  /** Always null now. The coordinator still accepts it; the page stopped asking. */
  address: string | null;
  zkeySha256: string;
  at: string;
}

export interface Attestation {
  address: string | null;
  handle: string | null;
  zkeySha256: string;
  contributionCount: number;
  at: string;
}

export interface Transcript {
  circuitHash: string | null;
  startedAt: string | null;
  drandRound: number | null;
  contributions: ContributionRecord[];
  attestations: Attestation[];
  finalised: CeremonyStatus['finalised'];
}

const BASE = import.meta.env.VITE_CEREMONY_URL ?? '/ceremony';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const getStatus = () => json<CeremonyStatus>('/status');
export const getTranscript = () => json<Transcript>('/transcript');

export interface Slot {
  token: string;
  expiresAt: string;
  baseSha256: string;
  contributionsBefore: number;
}

export const claimSlot = (meta: { displayName?: string | null }) =>
  json<Slot>('/slot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(meta),
  });

export type Phase = 'downloading' | 'contributing' | 'uploading';

/**
 * Randomness for the contribution.
 *
 * From the platform CSPRNG, plus whatever the participant typed. The typing is
 * not security theatre and it is not sufficient either: it exists so that a
 * contributor who does not trust this page's randomness can still be certain
 * their own entropy went in, and so that a browser with a broken RNG is not
 * the only thing standing behind their contribution.
 */
function entropy(userInput: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return userInput ? `${hex}:${userInput}` : hex;
}

export interface ContributeResult {
  accepted: true;
  index: number;
  hash: string;
  zkeySha256: string;
  contributions: number;
}

export async function contribute(opts: {
  token: string;
  name: string;
  userEntropy: string;
  onPhase: (phase: Phase, progress?: { loaded: number; total: number }) => void;
}): Promise<ContributeResult> {
  opts.onPhase('downloading');
  const res = await fetch(`${BASE}/zkey`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`could not fetch the key (${res.status})`);

  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body?.getReader();
  let current: Uint8Array;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      opts.onPhase('downloading', { loaded, total });
    }
    current = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) {
      current.set(c, at);
      at += c.byteLength;
    }
  } else {
    current = new Uint8Array(await res.arrayBuffer());
  }

  opts.onPhase('contributing');
  const snarkjs = await import('snarkjs');
  // snarkjs takes fastFile descriptors, and in a browser those are memory
  // objects rather than paths. The output has to be handed in as a writable
  // one — `{ type: 'mem' }` — and the bytes come back on `.data` afterwards.
  const output: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
  await snarkjs.zKey.contribute(current, output, opts.name, entropy(opts.userEntropy));

  const contributed = output.data;
  if (!contributed?.byteLength) {
    throw new Error('the contribution produced no output — nothing was uploaded');
  }

  opts.onPhase('uploading');
  const upload = await fetch(`${BASE}/contribute?token=${encodeURIComponent(opts.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: contributed as BodyInit,
  });
  const body = await upload.json().catch(() => ({}));
  if (!upload.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${upload.status}`);
  return body as ContributeResult;
}

export const attest = (a: { handle?: string | null; zkeySha256: string }) =>
  json<{ recorded: boolean; contributions: number }>('/attest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(a),
  });
