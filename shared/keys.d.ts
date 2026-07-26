export declare const DERIVATION_MESSAGE: string;

/** Seed from a signature over DERIVATION_MESSAGE. Hashes the signature bytes. */
export declare function seedFromSignature(signature: string): string;

/** Note `index` for this seed. Reduced mod the field and masked to 248 bits. */
export declare function deriveNoteSecrets(
  seed: string,
  index: number,
): { nullifier: bigint; secret: bigint };
