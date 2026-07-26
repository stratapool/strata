export declare const FIELD_SIZE: bigint;
export declare const ZERO_VALUE: bigint;

export declare function leInt2Buff(n: bigint | number, len: number): Uint8Array;
export declare function randomFieldElement(): bigint;

export interface Note {
  nullifier: bigint;
  secret: bigint;
  commitment: bigint;
  nullifierHash: bigint;
}

export declare function crypto(): Promise<{
  pedersenHash: (data: Uint8Array) => bigint;
  hashLeftRight: (left: bigint, right: bigint) => bigint;
}>;

export declare function createNote(): Promise<Note>;
export declare function encodeNote(note: Pick<Note, 'nullifier' | 'secret'>): string;
export declare function decodeNote(str: string): Promise<Note>;

export declare class MerkleTree {
  constructor(
    levels: number,
    hashLeftRight: (left: bigint, right: bigint) => bigint,
    leaves?: bigint[],
  );
  readonly levels: number;
  readonly leaves: bigint[];
  readonly zeros: bigint[];
  insert(leaf: bigint): number;
  root(): bigint;
  path(index: number): { pathElements: bigint[]; pathIndices: number[] };
}
