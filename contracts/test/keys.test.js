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
  notes: {
    0: {
      nullifier:
        '384932757289913990586122431459151153103997340044671009014615093353446531348',
      secret:
        '360517900505901194578954106207667481252498444088101007558365808808814557931',
    },
    1: {
      nullifier:
        '178475454143843953588925052451114604855829884953196656811681785617996562282',
      secret:
        '321714803099997298183801256985167949735174087240371514678713239765414415050',
    },
    49: {
      nullifier:
        '211947304420759841069081336224127128649612684514380484066921083060377092514',
      secret:
        '408401620726507300410354664153791901149751110159208246802639324436646545907',
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
      const { nullifier, secret } = keys.deriveNoteSecrets(VECTORS.seed, i);
      expect(nullifier < limit, `note[${i}].nullifier width`).to.equal(true);
      expect(secret < limit, `note[${i}].secret width`).to.equal(true);
    }
  });

  it('gives different wallets different notes at the same index', async () => {
    const other = new ethers.Wallet(
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    );
    const otherSeed = keys.seedFromSignature(
      await other.signMessage(keys.DERIVATION_MESSAGE),
    );
    expect(otherSeed).to.not.equal(VECTORS.seed);
    expect(keys.deriveNoteSecrets(otherSeed, 0).nullifier.toString()).to.not.equal(
      VECTORS.notes[0].nullifier,
    );
  });
});
