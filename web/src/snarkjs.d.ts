/**
 * snarkjs ships no types. Only the surface this client uses is declared, so a
 * typo in a call site is still a compile error.
 */
declare module 'snarkjs' {
  export namespace groth16 {
    function fullProve(
      input: Record<string, unknown>,
      wasmPath: string | Uint8Array,
      zkeyPath: string | Uint8Array,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;

    function verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
  }
}
