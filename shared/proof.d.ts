import type { MerkleTree, Note } from './note.js';

export interface SolidityProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

export interface PublicInputs {
  root: bigint | string;
  nullifierHash: bigint | string;
  recipient: string;
  relayer: string;
}

export declare function publicSignals(inputs: PublicInputs): string[];
export declare function toSolidityCalldata(proof: unknown): SolidityProof;
export declare function fromSolidityCalldata(cd: SolidityProof): unknown;

export declare function proveWithdrawal(args: {
  note: Note;
  tree: MerkleTree;
  leafIndex: number;
  recipient: string;
  relayer: string;
  wasmPath: string;
  zkeyPath: string;
}): Promise<{
  proof: SolidityProof;
  rawProof: unknown;
  signals: string[];
  root: bigint;
}>;
