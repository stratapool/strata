import { describe, expect, it } from 'vitest';
import { extendsChain, type Contribution } from './chain.js';

const c = (index: number, name: string, hash: string): Contribution => ({
  index,
  name,
  hash: hash.repeat(64).slice(0, 64),
});

/**
 * The coordinator's whole job is that a contribution cannot be erased.
 *
 * `zkey verify` does not provide that: it accepts a chain built by taking an
 * older key and adding to it, which is valid and silently drops everyone in
 * between. `extendsChain` is what makes the published transcript binding.
 */
describe('extendsChain', () => {
  const chain = [c(1, 'alice', 'a'), c(2, 'bob', 'b')];

  it('accepts exactly one new contribution on top', () => {
    const r = extendsChain(chain, [...chain, c(3, 'carol', 'c')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.added.name).toBe('carol');
  });

  it('rejects an upload that added nothing', () => {
    expect(extendsChain(chain, chain).ok).toBe(false);
  });

  it('rejects a fork that would erase a contributor', () => {
    // Same length as a valid extension, but #2 is somebody else's work.
    const forked = [c(1, 'alice', 'a'), c(2, 'mallory', 'f'), c(3, 'mallory', 'g')];
    const r = extendsChain(chain, forked);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not match the published transcript/);
  });

  it('rejects two contributions at once', () => {
    // This is the shape the newline-in-name attack produced: the upload really
    // held two new contributions, and the parser had reported only one. Even
    // once it is counted correctly, batching is not what a slot was issued for
    // — one participant must not occupy two places in the transcript.
    const r = extendsChain(chain, [...chain, c(3, 'm', 'c'), c(4, 'm', 'd')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exactly one new contribution/);
  });

  it('rejects a shorter chain', () => {
    expect(extendsChain(chain, [c(1, 'alice', 'a')]).ok).toBe(false);
  });

  it('accepts the first contribution to an empty ceremony', () => {
    const r = extendsChain([], [c(1, 'first', 'a')]);
    expect(r.ok).toBe(true);
  });
});
