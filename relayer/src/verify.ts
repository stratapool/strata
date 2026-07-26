import { readFile } from 'node:fs/promises';
import * as snarkjs from 'snarkjs';
import type { WithdrawRequest } from './types.js';

/**
 * Off-chain proof verification, run before anything touches the chain.
 *
 * This is not an optimisation. Without it, anyone can POST garbage and the
 * relayer pays gas to discover it is garbage — a free way to drain the hot
 * wallet. Verification is a few milliseconds against a transaction that costs
 * real money and takes seconds.
 */
export class ProofVerifier {
  #vkey: unknown | null = null;

  constructor(private readonly vkeyPath: string) {}

  async load(): Promise<void> {
    this.#vkey = JSON.parse(await readFile(this.vkeyPath, 'utf8'));
  }

  /**
   * Public signals must be in the circuit's declaration order:
   * root, nullifierHash, recipient, relayer, fee, refund.
   */
  static publicSignals(req: WithdrawRequest): string[] {
    return [
      BigInt(req.root).toString(),
      BigInt(req.nullifierHash).toString(),
      BigInt(req.recipient).toString(),
      BigInt(req.relayer).toString(),
      '0', // fee — fixed by the contract, never negotiated
      '0', // refund
    ];
  }

  async verify(req: WithdrawRequest): Promise<boolean> {
    if (!this.#vkey) throw new Error('verification key not loaded');
    const proof = {
      pi_a: [req.proof.a[0], req.proof.a[1], '1'],
      // snarkjs expects G2 coordinates in the order the proof was produced in,
      // which is the transpose of the Solidity calldata layout.
      pi_b: [
        [req.proof.b[0][1], req.proof.b[0][0]],
        [req.proof.b[1][1], req.proof.b[1][0]],
        ['1', '0'],
      ],
      pi_c: [req.proof.c[0], req.proof.c[1], '1'],
      protocol: 'groth16',
      curve: 'bn128',
    };
    try {
      return await snarkjs.groth16.verify(
        this.#vkey,
        ProofVerifier.publicSignals(req),
        proof,
      );
    } catch {
      // A malformed proof throws rather than returning false; either way it
      // does not get to cost us a transaction.
      return false;
    }
  }
}
