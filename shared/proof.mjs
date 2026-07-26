/**
 * Proof generation and the one place the G2 coordinate order is handled.
 *
 * snarkjs emits pi_b in the order the pairing library wants; the Solidity
 * verifier expects each pair swapped. Getting that backwards produces proofs
 * that fail everywhere (annoying but safe) or — if the two sides disagree
 * about it — proofs that pass one check and fail the other. Keeping the swap
 * in a single exported pair of functions means the client, the relayer and
 * the tests cannot hold different opinions about it.
 */
import * as snarkjs from 'snarkjs';

/**
 * Public signals in the circuit's declaration order. Any other order silently
 * verifies against the wrong statement.
 */
export function publicSignals({ root, nullifierHash, recipient, relayer }) {
  return [
    BigInt(root).toString(),
    BigInt(nullifierHash).toString(),
    BigInt(recipient).toString(),
    BigInt(relayer).toString(),
    '0', // fee   — fixed by the contract, never negotiated per-withdrawal
    '0', // refund — unused; kept only because removing it would edit the circuit
  ];
}

/** snarkjs proof object -> the shape PrivacyPool.withdraw expects. */
export function toSolidityCalldata(proof) {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
  };
}

/** The exact inverse, for verifying calldata off-chain. */
export function fromSolidityCalldata(cd) {
  return {
    pi_a: [cd.a[0], cd.a[1], '1'],
    pi_b: [
      [cd.b[0][1], cd.b[0][0]],
      [cd.b[1][1], cd.b[1][0]],
      ['1', '0'],
    ],
    pi_c: [cd.c[0], cd.c[1], '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}

/**
 * Build a withdrawal proof. Runs entirely client-side: the secrets never
 * leave the machine, and the relayer only ever sees the finished proof.
 */
export async function proveWithdrawal({
  note,
  tree,
  leafIndex,
  recipient,
  relayer,
  wasmPath,
  zkeyPath,
}) {
  const { pathElements, pathIndices } = tree.path(leafIndex);
  const root = tree.root();

  const { proof, publicSignals: signals } = await snarkjs.groth16.fullProve(
    {
      root,
      nullifierHash: note.nullifierHash,
      recipient: BigInt(recipient),
      relayer: BigInt(relayer),
      fee: 0n,
      refund: 0n,
      nullifier: note.nullifier,
      secret: note.secret,
      pathElements,
      pathIndices,
    },
    wasmPath,
    zkeyPath,
  );

  return { proof: toSolidityCalldata(proof), rawProof: proof, signals, root };
}
