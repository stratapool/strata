import { describe, expect, it } from 'vitest';
import createBlakeHash from './blake-hash';

/**
 * The browser shim must hash identically to the package it replaces.
 *
 * These base points feed the Pedersen hash, the Pedersen hash produces the
 * commitment, the commitment goes into the merkle tree, and the circuit was
 * built against exactly these values. A shim that differs by one bit yields
 * notes that deposit successfully and can never be withdrawn — no revert, no
 * error, just a commitment nobody's client will ever match.
 *
 * The vectors are BLAKE-256's own published test vectors, so this checks the
 * algorithm rather than checking the shim against itself.
 */
const hex = (b: Uint8Array | string) =>
  typeof b === 'string' ? b : Buffer.from(b).toString('hex');

describe('blake-hash browser shim', () => {
  it('matches the BLAKE-256 test vector for a single zero byte', () => {
    const digest = createBlakeHash('blake256').update(new Uint8Array([0])).digest();
    expect(hex(digest)).toBe(
      '0ce8d4ef4dd7cd8d62dfded9d4edb0a774ae6a41929a74da23109e8f11139c87',
    );
  });

  it('matches the BLAKE-256 test vector for 72 zero bytes', () => {
    const digest = createBlakeHash('blake256').update(new Uint8Array(72)).digest();
    expect(hex(digest)).toBe(
      'd419bad32d504fb7d44d460c42c5593fe544fa4c135dec31e21bd9abdcc22d41',
    );
  });

  it('accepts a string with an encoding, as circomlibjs may', () => {
    const fromString = createBlakeHash('blake256').update('abc', 'utf8').digest();
    const fromBytes = createBlakeHash('blake256')
      .update(new TextEncoder().encode('abc'))
      .digest();
    expect(hex(fromString)).toBe(hex(fromBytes));
  });

  it('returns an encoded string when asked, and bytes otherwise', () => {
    const bytes = createBlakeHash('blake256').update(new Uint8Array([0])).digest();
    const string = createBlakeHash('blake256').update(new Uint8Array([0])).digest('hex');
    expect(typeof string).toBe('string');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(string).toBe(hex(bytes));
  });

  it('refuses a second digest, like the package it replaces', () => {
    const h = createBlakeHash('blake256').update(new Uint8Array([1]));
    h.digest();
    expect(() => h.digest()).toThrow(/already called/i);
    expect(() => h.update(new Uint8Array([2]))).toThrow(/already called/i);
  });

  it('rejects an unknown algorithm', () => {
    expect(() => createBlakeHash('sha256')).toThrow(/algorithm/i);
  });
});
