/**
 * Note construction and the Merkle tree, mirrored in JavaScript.
 *
 * These MUST agree bit-for-bit with the circuit and the contract. Three
 * independent implementations of the same hash (circom, Solidity, JS) is an
 * inherent hazard of this design; the end-to-end test exists to catch drift,
 * because a mismatch produces notes that can be deposited and never spent.
 *
 * Shared deliberately: contracts, relayer and web all need note construction,
 * and three copies of it would drift into three subtly different note formats.
 * Imported by relative path rather than published, so there is no version skew
 * between what the tests exercise and what ships.
 */
import { buildBabyjub, buildMimcSponge, buildPedersenHash } from 'circomlibjs';

// Isomorphic by necessity: this module runs in the browser (where the user's
// secrets are generated and must never leave) and in Node (tests, relayer).
// Web Crypto and Uint8Array exist in both; node:crypto and Buffer do not.
const webcrypto = globalThis.crypto;
if (!webcrypto?.getRandomValues) {
  throw new Error('Web Crypto unavailable — refusing to generate note secrets');
}

const toHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));

function concatBytes(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const ZERO_VALUE =
  21663839004416932945382355908790599225266501822907911457504978515578255421292n;

/** Little-endian fixed-width encoding, matching circomlib's leInt2Buff. */
export function leInt2Buff(n, len) {
  const buf = new Uint8Array(len);
  let x = BigInt(n);
  for (let i = 0; i < len; i++) {
    buf[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error('value does not fit in requested width');
  return buf;
}

/**
 * 31 bytes = 248 bits, comfortably inside the 254-bit bn254 scalar field.
 * The circuit's Num2Bits(248) enforces exactly this width; a wider value
 * would fail to witness.
 */
export function randomFieldElement() {
  const bytes = new Uint8Array(31);
  webcrypto.getRandomValues(bytes);
  return BigInt('0x' + toHex(bytes));
}

let _ctx = null;
export async function crypto() {
  if (_ctx) return _ctx;
  const [pedersen, babyJub, mimc] = await Promise.all([
    buildPedersenHash(),
    buildBabyjub(),
    buildMimcSponge(),
  ]);

  const pedersenHash = (data) =>
    babyJub.F.toObject(babyJub.unpackPoint(pedersen.hash(data))[0]);

  const hashLeftRight = (l, r) =>
    BigInt(mimc.F.toString(mimc.multiHash([l, r], 0n, 1)));

  _ctx = { pedersenHash, hashLeftRight };
  return _ctx;
}

/** A note is the pair of secrets that authorises exactly one withdrawal. */
export async function createNote() {
  const { pedersenHash } = await crypto();
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const commitment = pedersenHash(
    concatBytes(leInt2Buff(nullifier, 31), leInt2Buff(secret, 31)),
  );
  const nullifierHash = pedersenHash(leInt2Buff(nullifier, 31));
  return { nullifier, secret, commitment, nullifierHash };
}

/** Serialised form a user would back up or hand to someone else. */
export function encodeNote({ nullifier, secret }) {
  return `strata-note-v1-${toHex(leInt2Buff(nullifier, 31))}${toHex(leInt2Buff(secret, 31))}`;
}

export async function decodeNote(str) {
  const m = /^strata-note-v1-([0-9a-f]{124})$/.exec(str.trim());
  if (!m) throw new Error('malformed note');
  const bytes = fromHex(m[1]);
  const toBig = (b) => BigInt('0x' + toHex(Uint8Array.from(b).reverse()));
  const nullifier = toBig(bytes.subarray(0, 31));
  const secret = toBig(bytes.subarray(31, 62));
  const { pedersenHash } = await crypto();
  return {
    nullifier,
    secret,
    commitment: pedersenHash(
      concatBytes(leInt2Buff(nullifier, 31), leInt2Buff(secret, 31)),
    ),
    nullifierHash: pedersenHash(leInt2Buff(nullifier, 31)),
  };
}

/**
 * Fixed-depth incremental Merkle tree, matching MerkleTreeWithHistory.
 *
 * Rebuilt from the full leaf list rather than maintained incrementally: the
 * client has to reconstruct it from chain events anyway, and a from-scratch
 * build is far easier to verify against the contract than a stateful one.
 */
export class MerkleTree {
  constructor(levels, hashLeftRight, leaves = []) {
    this.levels = levels;
    this.hashLeftRight = hashLeftRight;
    this.zeros = [ZERO_VALUE];
    for (let i = 1; i <= levels; i++) {
      this.zeros.push(hashLeftRight(this.zeros[i - 1], this.zeros[i - 1]));
    }
    this.leaves = [...leaves];
  }

  insert(leaf) {
    if (this.leaves.length >= 2 ** this.levels) throw new Error('tree is full');
    this.leaves.push(leaf);
    return this.leaves.length - 1;
  }

  #layers() {
    const layers = [this.leaves.slice()];
    for (let lvl = 0; lvl < this.levels; lvl++) {
      const cur = layers[lvl];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        const left = cur[i];
        const right = i + 1 < cur.length ? cur[i + 1] : this.zeros[lvl];
        next.push(this.hashLeftRight(left, right));
      }
      layers.push(next);
    }
    return layers;
  }

  root() {
    const layers = this.#layers();
    const top = layers[this.levels];
    return top.length ? top[0] : this.zeros[this.levels];
  }

  /** Sibling hashes and left/right selectors from leaf to root. */
  path(index) {
    if (index < 0 || index >= this.leaves.length) throw new Error('no such leaf');
    const layers = this.#layers();
    const pathElements = [];
    const pathIndices = [];
    let idx = index;
    for (let lvl = 0; lvl < this.levels; lvl++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      const layer = layers[lvl];
      pathElements.push(
        siblingIdx < layer.length ? layer[siblingIdx] : this.zeros[lvl],
      );
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }
}
