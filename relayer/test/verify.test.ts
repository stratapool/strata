import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import { ProofVerifier } from '../src/verify.js';
import type { WithdrawRequest } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.resolve(HERE, '../../circuits/build');
const WASM = path.join(CIRCUITS, 'withdraw_js/withdraw.wasm');
const ZKEY = path.join(CIRCUITS, 'withdraw_final.zkey');
const VKEY = path.join(CIRCUITS, 'verification_key.json');

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const RELAYER = '0x2222222222222222222222222222222222222222';

let verifier: ProofVerifier;
let request: WithdrawRequest;

const toHex32 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');

beforeAll(async () => {
  const { createNote, crypto, MerkleTree } = await import('@strata/shared/note');
  const { proveWithdrawal } = await import('@strata/shared/proof');

  const { hashLeftRight } = await crypto();
  const tree = new MerkleTree(20, hashLeftRight);

  // Three leaves so the proven note is not trivially the only one.
  const notes = [];
  for (let i = 0; i < 3; i++) {
    const n = await createNote();
    tree.insert(n.commitment);
    notes.push(n);
  }
  const note = notes[1]!;

  const { proof, root } = await proveWithdrawal({
    note,
    tree,
    leafIndex: 1,
    recipient: RECIPIENT,
    relayer: RELAYER,
    wasmPath: WASM,
    zkeyPath: ZKEY,
  });

  request = {
    proof,
    root: toHex32(root),
    nullifierHash: toHex32(note.nullifierHash),
    recipient: RECIPIENT,
    relayer: RELAYER,
  };

  verifier = new ProofVerifier(VKEY);
  await verifier.load();
}, 120_000);

describe('ProofVerifier', () => {
  it('accepts a genuine proof', async () => {
    // Also pins the G2 coordinate order: if the relayer's transpose disagreed
    // with the one used to build the calldata, this would fail.
    expect(await verifier.verify(request)).toBe(true);
  });

  it('rejects a proof whose recipient was swapped', async () => {
    // The attack this service exists to make impossible: a relayer rewriting
    // the payout address. It must be caught here, before any gas is spent.
    const tampered = { ...request, recipient: '0x3333333333333333333333333333333333333333' };
    expect(await verifier.verify(tampered)).toBe(false);
  });

  it('rejects a proof whose relayer was swapped', async () => {
    const tampered = { ...request, relayer: '0x4444444444444444444444444444444444444444' };
    expect(await verifier.verify(tampered)).toBe(false);
  });

  it('rejects a proof against a different merkle root', async () => {
    const tampered = { ...request, root: toHex32(999n) };
    expect(await verifier.verify(tampered)).toBe(false);
  });

  it('rejects a mangled proof without throwing', async () => {
    // Garbage must cost the relayer a few milliseconds, never a transaction.
    const tampered = {
      ...request,
      proof: { ...request.proof, a: ['1', '2'] as [string, string] },
    };
    expect(await verifier.verify(tampered)).toBe(false);
  });

  it('orders public signals as the circuit declares them', () => {
    const signals = ProofVerifier.publicSignals(request);
    expect(signals).toEqual([
      BigInt(request.root).toString(),
      BigInt(request.nullifierHash).toString(),
      BigInt(RECIPIENT).toString(),
      BigInt(RELAYER).toString(),
      '0',
      '0',
    ]);
  });
});
