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

    this.#zkey = new Uint8Array(await response.arrayBuffer());
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
