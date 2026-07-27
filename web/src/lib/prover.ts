/**
 * Browser-side proof generation.
 *
 * The proving key is ~20 MB. It is fetched lazily — only when a user actually
 * starts a withdrawal — and cached in the Cache API so it survives reloads.
 *
 * Proving happens here, in the page, and nowhere else. Handing the note
 * secrets to a server to prove on the user's behalf would be faster and would
 * also hand that server the ability to link every deposit to its withdrawal,
 * which is the one thing this whole system exists to prevent.
 */
const CACHE_NAME = 'strata-proving-key-v1';

/**
 * The hash the filename commits to, if it carries one.
 *
 * `withdraw_final.<sha8>.zkey` — the deploy names the file after the first
 * eight hex of its SHA-256, and the README publishes the full value. Until now
 * nothing checked it. That mattered less for a first bad response — a host that
 * can serve a poisoned key can also serve JS that reads the secrets outright —
 * and a great deal for what happened next: the file is cached with a one-year
 * immutable lifetime and `cache.match` never revalidates, so a single bad
 * response outlived the host being fixed. The only symptom was withdrawals
 * failing at the relayer with nothing pointing at a cache.
 */
function expectedPrefix(url: string): string | null {
  return /\.([0-9a-f]{8})\.zkey(?:[?#].*)?$/.exec(url)?.[1] ?? null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export interface ProverAssets {
  wasm: string;
  zkey: string;
}

export interface DownloadProgress {
  loaded: number;
  total: number;
}

export class Prover {
  #zkey: Uint8Array | null = null;

  constructor(private readonly assets: ProverAssets) {}

  get ready(): boolean {
    return this.#zkey !== null;
  }

  /** Fetches and caches the proving key. Safe to call repeatedly. */
  async warmUp(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (this.#zkey) return;

    const cache = await caches.open(CACHE_NAME);
    let response = await cache.match(this.assets.zkey);

    if (!response) {
      const fresh = await fetch(this.assets.zkey);
      if (!fresh.ok) throw new Error(`proving key unavailable (${fresh.status})`);
      // Tee the stream so progress can be reported while the response is
      // still being handed to the cache intact.
      const total = Number(fresh.headers.get('content-length') ?? 0);
      const reader = fresh.clone().body?.getReader();
      if (reader && onProgress) {
        void (async () => {
          let loaded = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.byteLength;
            onProgress({ loaded, total });
          }
        })();
      }
      await cache.put(this.assets.zkey, fresh.clone());
      response = fresh;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    // Checked on every warm-up, not only on download: the point is to catch a
    // poisoned copy that is already in the cache, which is the case that
    // persists. A mismatch evicts it so the next attempt refetches rather than
    // failing identically forever.
    const want = expectedPrefix(this.assets.zkey);
    if (want) {
      const got = await sha256Hex(bytes);
      if (!got.startsWith(want)) {
        await caches.delete(CACHE_NAME);
        this.#zkey = null;
        throw new Error(
          `The proving key does not match its published hash — expected ` +
            `${want}…, got ${got.slice(0, 8)}…. The cached copy has been ` +
            `discarded. If this repeats, do not deposit or withdraw here.`,
        );
      }
    }

    this.#zkey = bytes;
  }

  async prove(input: Record<string, unknown>): Promise<{
    proof: unknown;
    publicSignals: string[];
  }> {
    if (!this.#zkey) await this.warmUp();
    const snarkjs = await import('snarkjs');
    return snarkjs.groth16.fullProve(input, this.assets.wasm, this.#zkey!);
  }

  /** Frees the cached key. Offered in settings for shared machines. */
  static async clearCache(): Promise<void> {
    await caches.delete(CACHE_NAME);
  }
}
