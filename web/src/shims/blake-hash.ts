import engines from 'blake-hash/lib';

/**
 * `blake-hash` without the Node stream it never needed.
 *
 * circomlibjs derives the Pedersen base points with
 * `createBlakeHash("blake256").update(S).digest()`. The package's browser entry
 * reaches that through `lib/api/blake.js`, which extends `readable-stream`'s
 * Transform — and `readable-stream` does `require('stream')`, which a browser
 * build resolves to nothing. The result was `Stream.call(this)` on undefined,
 * thrown from every pedersenHash the client made: the note scan, every deposit,
 * every withdrawal. It never surfaced during development because the end-to-end
 * tests run in Node, where the same code path works.
 *
 * The Transform base class only ever provided a streaming interface nobody
 * here uses. This keeps `blake-hash`'s own engines — the actual hashing, in
 * `lib/blake256.js`, which has no dependencies — and reimplements the six lines
 * of wrapper around them.
 *
 * Using a different BLAKE implementation would have been the wrong fix by a
 * wide margin: the base points feed the commitment, the commitment goes in the
 * merkle tree, and the circuit expects exactly these. A hash that differs by a
 * bit produces notes that deposit successfully and can never be withdrawn.
 * contracts/test/pool.test.js pins the values against the circuit.
 */

interface Engine {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
}

type Algorithm = 'blake224' | 'blake256' | 'blake384' | 'blake512';

const TABLE: Record<Algorithm, new () => Engine> = {
  blake224: engines.Blake224,
  blake256: engines.Blake256,
  blake384: engines.Blake384,
  blake512: engines.Blake512,
};

class BlakeHash {
  #engine: Engine;
  #finalized = false;

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  update(data: Uint8Array | string, encoding?: BufferEncoding): this {
    if (this.#finalized) throw new Error('Digest already called');
    const bytes =
      typeof data === 'string' ? Buffer.from(data, encoding) : data;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('Data must be a string or a buffer');
    }
    this.#engine.update(bytes);
    return this;
  }

  digest(encoding?: BufferEncoding): Uint8Array | string {
    if (this.#finalized) throw new Error('Digest already called');
    this.#finalized = true;
    const digest = this.#engine.digest();
    return encoding === undefined
      ? digest
      : Buffer.from(digest).toString(encoding);
  }
}

export default function createBlakeHash(algorithm: string): BlakeHash {
  const key = algorithm.toLowerCase() as Algorithm;
  const Engine = TABLE[key];
  if (!Engine) throw new Error(`Invald algorithm: ${algorithm}`);
  return new BlakeHash(new Engine());
}
