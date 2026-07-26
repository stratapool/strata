import { keccak256, toUtf8Bytes, type Eip1193Provider, BrowserProvider } from 'ethers';

/**
 * Deterministic note keys derived from a wallet signature.
 *
 * The wallet is not custodying anything new: signing the same message always
 * reproduces the same seed, so a user can recover every note on any device
 * with the same wallet and nothing else.
 *
 * The trade-off is real and must be surfaced in the UI: there is no forward
 * secrecy. A compromised wallet exposes every note ever derived from it, past
 * and future. Users protecting large amounts should generate random notes
 * instead and back them up out of band.
 */
const DERIVATION_MESSAGE = [
  'Strata — derive private note keys',
  '',
  'Signing this message derives the keys that control your private balance.',
  'It does not authorise any transaction and costs nothing.',
  '',
  'Only ever sign this on a site you trust.',
  'chain: 4663',
  'version: 1',
].join('\n');

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export async function deriveSeed(
  provider: Eip1193Provider,
  account: string,
): Promise<string> {
  const browser = new BrowserProvider(provider);
  const signer = await browser.getSigner(account);
  const signature = await signer.signMessage(DERIVATION_MESSAGE);
  return keccak256(signature);
}

/**
 * Derives note i from the seed.
 *
 * Reduced mod the field and masked to 248 bits, because the circuit's
 * Num2Bits(248) will refuse to witness anything wider.
 */
export function deriveNoteSecrets(seed: string, index: number): {
  nullifier: bigint;
  secret: bigint;
} {
  const at = (tag: string) =>
    (BigInt(keccak256(toUtf8Bytes(`${seed}:${index}:${tag}`))) %
      FIELD_SIZE) &
    ((1n << 248n) - 1n);
  return { nullifier: at('nullifier'), secret: at('secret') };
}
