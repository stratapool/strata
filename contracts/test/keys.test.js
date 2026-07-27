const { expect } = require('chai');
const { ethers } = require('ethers');

/**
 * Frozen vectors for note-key derivation.
 *
 * Every note in the pool is derived from a wallet signature rather than random
 * bytes, so the derivation *is* the backup — a user recovers by signing the
 * same message again, and nothing else needs to survive. That makes any change
 * to it silently destructive: notes deposited under the old scheme still sit in
 * the tree, but the client looking for them computes different commitments and
 * simply never finds a match. No revert, no error, no way back.
 *
 * These values were produced by the implementation the browser shipped with,
 * and cross-checked against it independently. If this test fails, the
 * derivation changed and every note already in the pool became unreachable.
 * Bump `version:` in DERIVATION_MESSAGE and add vectors — do not edit these.
 */
const VECTORS = {
  privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
  address: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  signature:
    '0xe00b820cfdac52089db8e6bf9831252887c554ad3cc38999cb9db4ffc3873aa059a8a85348d1f47d7f0ea296849082bf729ac289b68f7dfc2cbc37245a6f648d1c',
  seed: '0x582a21c481d6505697c8de4f3565c1fae079bc300b820b2958857cfcc5a359da',
  pool: '0x5f7317Fd48737E3462B308b64CbA3e557e68B240',
  otherPool: '0x40aF9DE1EE5125772e4E3192fAf53B57f4d5A249',
  notes: {
    0: {
      nullifier:
        '26329824786644396548079690865106606163669526454519913527863020161500569454',
      secret:
        '37550329843680277687387544996535882361524474964080990464633418821181877093',
    },
    1: {
      nullifier:
        '26839468252858394882372546524540653159198547003391274988141932557601675343',
      secret:
        '396079709781349547194560565438542143119257322169242571971558360636785931213',
    },
    49: {
      nullifier:
        '294068741931828422437503605412143169841472858880171563930236718822426564660',
      secret:
        '147202603264518871749600759392272464044937692794206620574192302882508925093',
    },
  },
};

describe('note key derivation', () => {
  let keys;

  before(async () => {
    keys = await import('@strata/shared/keys');
  });

  it('signs a message that is bound to the chain and carries a version', () => {
    expect(keys.DERIVATION_MESSAGE).to.include('chain: 4663');
    expect(keys.DERIVATION_MESSAGE).to.include('version: 1');
  });

  it('produces the frozen signature for the frozen key', async () => {
    const wallet = new ethers.Wallet(VECTORS.privateKey);
    expect(wallet.address).to.equal(VECTORS.address);
    expect(await wallet.signMessage(keys.DERIVATION_MESSAGE)).to.equal(
      VECTORS.signature,
    );
  });

  it('derives the frozen seed from that signature', () => {
    expect(keys.seedFromSignature(VECTORS.signature)).to.equal(VECTORS.seed);
  });

  it('derives the frozen note secrets from that seed', () => {
    for (const [index, expected] of Object.entries(VECTORS.notes)) {
      const { nullifier, secret } = keys.deriveNoteSecrets(
        VECTORS.seed,
        VECTORS.pool,
        Number(index),
      );
      expect(nullifier.toString(), `note[${index}].nullifier`).to.equal(
        expected.nullifier,
      );
      expect(secret.toString(), `note[${index}].secret`).to.equal(
        expected.secret,
      );
    }
  });

  it('keeps every derived value inside the circuit\'s 248-bit window', () => {
    // Num2Bits(248) in the circuit refuses to witness anything wider, so a
    // derivation that overflowed would produce notes that cannot be proven —
    // depositable, and then unspendable.
    const limit = 1n << 248n;
    for (let i = 0; i < 64; i++) {
      const { nullifier, secret } = keys.deriveNoteSecrets(VECTORS.seed, VECTORS.pool, i);
      expect(nullifier < limit, `note[${i}].nullifier width`).to.equal(true);
      expect(secret < limit, `note[${i}].secret width`).to.equal(true);
    }
  });

  it('gives different pools different notes for the same wallet and index', () => {
    // Without this, one wallet deposited a byte-identical commitment into every
    // pool. Two pools whose leaves share a prefix publish the same roots, and a
    // proof carries no pool identity — so a withdrawal from one is valid
    // calldata for the other, force-spending the victim's second note and
    // publishing the link between their deposits.
    const here = keys.deriveNoteSecrets(VECTORS.seed, VECTORS.pool, 0);
    const there = keys.deriveNoteSecrets(VECTORS.seed, VECTORS.otherPool, 0);
    expect(here.nullifier).to.not.equal(there.nullifier);
    expect(here.secret).to.not.equal(there.secret);
  });

  it('treats a checksummed and a lowercased pool address as the same pool', () => {
    const a = keys.deriveNoteSecrets(VECTORS.seed, VECTORS.pool, 3);
    const b = keys.deriveNoteSecrets(VECTORS.seed, VECTORS.pool.toLowerCase(), 3);
    expect(a.nullifier).to.equal(b.nullifier);
    expect(a.secret).to.equal(b.secret);
  });

  it('refuses to derive without a pool address', () => {
    expect(() => keys.deriveNoteSecrets(VECTORS.seed, undefined, 0)).to.throw(
      /pool address/i,
    );
    expect(() => keys.deriveNoteSecrets(VECTORS.seed, 'not-an-address', 0)).to.throw(
      /pool address/i,
    );
  });

  it('gives different wallets different notes at the same index', async () => {
    const other = new ethers.Wallet(
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    );
    const otherSeed = keys.seedFromSignature(
      await other.signMessage(keys.DERIVATION_MESSAGE),
    );
    expect(otherSeed).to.not.equal(VECTORS.seed);
    expect(
      keys.deriveNoteSecrets(otherSeed, VECTORS.pool, 0).nullifier.toString(),
    ).to.not.equal(VECTORS.notes[0].nullifier);
  });
});
