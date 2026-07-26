import { type Eip1193Provider, BrowserProvider } from 'ethers';
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
export async function deriveSeed(
  provider: Eip1193Provider,
  account: string,
): Promise<string> {
  const browser = new BrowserProvider(provider);
  const signer = await browser.getSigner(account);
  return seedFromSignature(await signer.signMessage(DERIVATION_MESSAGE));
}
