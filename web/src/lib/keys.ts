import { type Eip1193Provider, BrowserProvider, keccak256, toUtf8Bytes } from 'ethers';
import { DERIVATION_MESSAGE, seedFromSignature } from '@strata/shared/keys';

export { deriveNoteSecrets } from '@strata/shared/keys';

/**
 * Deterministic note keys derived from a wallet signature.
 *
 * The wallet is not custodying anything new: signing the same message always
 * reproduces the same seed, so a user can recover every note on any device
 * with the same wallet and nothing else.
 *
 * The derivation itself lives in @strata/shared/keys, not here. It used to be
 * a second copy alongside the one the seeding scripts use, which is the worst
 * possible thing to duplicate: two implementations that disagree produce notes
 * one side deposits and the other can never find, with no revert and no error
 * — the commitment simply never matches. contracts/test/keys.test.js pins the
 * output against frozen vectors so a change cannot land quietly.
 *
 * The trade-off is real and must stay surfaced in the UI: there is no forward
 * secrecy. A compromised wallet exposes every note ever derived from it, past
 * and future. Users protecting large amounts should generate random notes
 * instead and back them up out of band.
 */

const FINGERPRINTS = 'strata.seed-fingerprint.v1';

/**
 * A fingerprint of the seed, not the seed.
 *
 * Stored so a wallet that starts producing a different signature is caught
 * rather than silently losing everything derived from the old one. Hashed
 * because a seed in local storage is every note the wallet will ever hold, and
 * this file exists to protect exactly that.
 *
 * The address is hashed too. It is already in local storage under AppKit's own
 * balance cache, so this does not conceal anything new — it just declines to
 * add a second copy.
 */
const fingerprint = (v: string) => keccak256(toUtf8Bytes(v)).slice(2, 34);

function readFingerprints(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(FINGERPRINTS) ?? '{}');
  } catch {
    return {};
  }
}

function writeFingerprint(accountKey: string, value: string): void {
  try {
    const all = readFingerprints();
    all[accountKey] = value;
    localStorage.setItem(FINGERPRINTS, JSON.stringify(all));
  } catch {
    // Private browsing, quota, a locked-down profile. The double-signature
    // check below still runs on every unlock in that case — more prompts, same
    // protection. Failing the unlock over storage would be the wrong trade.
  }
}

/**
 * Derives the seed, and refuses to hand back one that cannot be reproduced.
 *
 * Every note is derived from this value, so the wallet is the backup and a
 * signature that changes between sessions is total, silent loss: the next
 * unlock derives a different seed, the scan matches no commitments, and the
 * balance reads zero exactly as it would for a wallet that never deposited.
 * No error is raised anywhere, because nothing is wrong from the client's
 * point of view — it simply looked for notes that do not exist.
 *
 * Most wallets sign deterministically (RFC 6979) and this is a formality.
 * Smart-contract wallets such as Safe do not — the signature depends on which
 * owners signed — and passkey/WebAuthn accounts use a random nonce by design.
 * Those users must not be allowed to deposit, and the only way to know which
 * kind is holding the connection is to ask it to sign twice and compare.
 *
 * Once per wallet, ever: the result is remembered by fingerprint, and later
 * unlocks cost one signature and are still checked against it.
 */
export async function deriveSeed(
  provider: Eip1193Provider,
  account: string,
): Promise<string> {
  const browser = new BrowserProvider(provider);
  const signer = await browser.getSigner(account);

  const seed = seedFromSignature(await signer.signMessage(DERIVATION_MESSAGE));
  const accountKey = fingerprint(account.toLowerCase());
  const seen = readFingerprints()[accountKey];
  const current = fingerprint(seed);

  if (seen === undefined) {
    const again = seedFromSignature(
      await signer.signMessage(DERIVATION_MESSAGE),
    );
    if (again !== seed) {
      throw new Error(
        'This wallet signs the same message differently each time, so the keys ' +
          'to your notes could not be rebuilt later — anything deposited would ' +
          'be unrecoverable. Smart-contract wallets and passkey accounts behave ' +
          'this way. Connect a wallet that signs deterministically, such as ' +
          'MetaMask or Rabby.',
      );
    }
    writeFingerprint(accountKey, current);
    return seed;
  }

  if (seen !== current) {
    throw new Error(
      'This wallet produced a different signature than it did before, so it ' +
        'would derive different note keys. Any notes it already holds are ' +
        'reachable only from the original signature. Nothing has been lost yet ' +
        '— do not deposit until this is resolved.',
    );
  }

  return seed;
}
