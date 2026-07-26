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

  export namespace zKey {
    /**
     * In a browser the two file arguments are fastFile memory descriptors
     * rather than paths: a Uint8Array going in, and `{ type: 'mem' }` coming
     * out, whose bytes land on `.data` once the call resolves.
     */
    function contribute(
      zkeyOld: Uint8Array | string,
      zkeyNew: { type: 'mem'; data?: Uint8Array } | string,
      name: string,
      entropy: string,
      logger?: unknown,
    ): Promise<unknown>;
  }
}
