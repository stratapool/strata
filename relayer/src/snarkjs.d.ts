/**
 * snarkjs ships no types. Only the surface this service actually uses is
 * declared, so a typo in a call site is still caught.
 */
declare module 'snarkjs' {
  export namespace groth16 {
    function verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
  }
}
