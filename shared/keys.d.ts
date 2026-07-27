export declare const DERIVATION_MESSAGE: string;

/** Seed from a signature over DERIVATION_MESSAGE. Hashes the signature bytes. */
export declare function seedFromSignature(signature: string): string;

/**
 * Note `index` for this seed, scoped to `pool`.
 *
 * The pool address is required: without it the same wallet derives identical
 * commitments in every pool, and a withdrawal proof from one is valid calldata
 * for another sharing a verifier.
 */
export declare function deriveNoteSecrets(
  seed: string,
  pool: string,
  index: number,
): { nullifier: bigint; secret: bigint };
