/**
 * snarkjs ships no types. Only the surface this service uses is declared, so a
 * typo in a call site is still caught.
 */
declare module 'snarkjs' {
  export interface SnarkjsLogger {
    info?(message: unknown): void;
    debug?(message: unknown): void;
    warn?(message: unknown): void;
    error?(message: unknown): void;
    log?(message: unknown): void;
  }

  export namespace zKey {
    /**
     * Validates a phase-2 key against the circuit and the powers of tau, and
     * reports every contribution in the chain through the logger.
     */
    function verifyFromR1cs(
      r1csPath: string,
      ptauPath: string,
      zkeyPath: string,
      logger?: SnarkjsLogger,
    ): Promise<boolean>;

    function contribute(
      zkeyPathOld: string,
      zkeyPathNew: string,
      name: string,
      entropy: string,
      logger?: SnarkjsLogger,
    ): Promise<unknown>;

    function beacon(
      zkeyPathOld: string,
      zkeyPathNew: string,
      name: string,
      beaconHashStr: string,
      numIterationsExp: number,
      logger?: SnarkjsLogger,
    ): Promise<unknown>;

    function exportVerificationKey(
      zkeyPath: string,
      logger?: SnarkjsLogger,
    ): Promise<unknown>;

    function exportSolidityVerifier(
      zkeyPath: string,
      templates: Record<string, string>,
      logger?: SnarkjsLogger,
    ): Promise<string>;
  }
}
