/**
 * Deterministic note keys, derived from a wallet signature.
 *
 * Shared for the same reason note.mjs is, but the stakes are higher: this is
 * the only thing standing between a lost file and lost money. The browser
 * derives notes with it, and any script that seeds the pool must derive them
 * the *same* way — if the two drift, notes deposited by one cannot be found by
 * the other, and the ETH behind them is gone. There is no second chance and no
 * error message; the commitment simply never matches.
 *
 * Random note secrets were the alternative, and they cost 0.08 ETH across two
 * incidents: generated in memory, written to a file, and the file was either
 * incomplete or the process died before it mattered. Derivation removes the
 * single point of failure entirely — the wallet is the backup, and the user
 * already has to keep it.
 *
 * keccak comes from @noble/hashes rather than ethers on purpose. This package
 * resolves ethers 5 through circomlibjs while its consumers use ethers 6, and
 * the two spell keccak256 differently; depending on it here would reintroduce
 * exactly the version skew this package exists to prevent.
 */
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * Signed verbatim. Changing a single byte changes every key derived from it,
 * so this string is frozen: it is bound to the chain and carries an explicit
 * version, and a new scheme must bump the version rather than edit the text.
 *
 * Deliberately NOT bound to a pool address: one signature has to recover a
 * user's notes in every pool, so the *seed* stays pool-independent. Individual
 * notes do not — see deriveNoteSecrets.
 */
export const DERIVATION_MESSAGE = [
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
/** The circuit's Num2Bits(248) refuses to witness anything wider. */
const MASK_248 = (1n << 248n) - 1n;

const toHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex) =>
  Uint8Array.from(
    (hex.startsWith('0x') ? hex.slice(2) : hex).match(/.{2}/g) ?? [],
    (b) => parseInt(b, 16),
  );

const utf8 = (s) => new TextEncoder().encode(s);

/**
 * The seed, from a signature over DERIVATION_MESSAGE.
 *
 * The signature is hashed as bytes, not as the text of its hex string.
 */
export function seedFromSignature(signature) {
  return `0x${toHex(keccak_256(fromHex(signature)))}`;
}

/**
 * Note `index` for this seed, in this pool.
 *
 * The pool address is in the hash for a reason that took an audit to surface.
 * Without it, the same wallet derived index 0 identically everywhere, and the
 * client restarts its index count per pool — so a user with a note in one pool
 * deposited a byte-identical commitment into the next one. Two pools whose leaf
 * sequences share a prefix publish the same merkle roots, and the circuit binds
 * no pool identity into a proof: the six public signals are root, nullifierHash,
 * recipient, relayer, fee, refund and nothing else. A withdrawal proof from one
 * pool is therefore valid calldata for another that shares a verifier, which
 * both deployed pools do.
 *
 * The consequence was not theft — mirroring leaves to a larger denomination
 * costs more than it yields — but anyone could copy a victim's proof into the
 * other pool, force-spend their second note to the same recipient, and publish
 * the link between their two deposits. That is precisely the property the pool
 * exists to prevent.
 *
 * Lowercased so a checksummed and an unchecksummed address cannot derive two
 * different notes for the same pool.
 *
 * The seed goes in as its hex *text*: `${seed}:${pool}:${index}:${tag}` is a
 * template string. Hashing the seed's bytes instead would be equally sound and
 * completely incompatible, which is the kind of difference that loses money
 * silently.
 */
export function deriveNoteSecrets(seed, pool, index) {
  if (typeof pool !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(pool)) {
    throw new Error(
      'deriveNoteSecrets needs the pool address — notes derived without it are ' +
        'identical across pools and replayable between them',
    );
  }
  const scope = pool.toLowerCase();
  const at = (tag) =>
    (BigInt(`0x${toHex(keccak_256(utf8(`${seed}:${scope}:${index}:${tag}`)))}`) %
      FIELD_SIZE) &
    MASK_248;
  return { nullifier: at('nullifier'), secret: at('secret') };
}
