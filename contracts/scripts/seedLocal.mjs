/**
 * Puts a handful of real deposits into a locally-deployed pool so the
 * frontend has something to read. Local development only.
 *
 * The notes are derived the same way the browser derives them — from a wallet
 * signature — so the web client can actually find and spend them.
 */
import hre from 'hardhat';
import { readFile } from 'node:fs/promises';

const { ethers } = hre;
const COUNT = Number(process.env.COUNT || 6);

async function main() {
  const net = await ethers.provider.getNetwork();
  const info = JSON.parse(
    await readFile(new URL(`../deployments/${net.chainId}.json`, import.meta.url), 'utf8'),
  );

  const [signer] = await ethers.getSigners();
  const pool = await ethers.getContractAt('PrivacyPool', info.contracts.pool, signer);
  const denomination = await pool.denomination();

  const { crypto, leInt2Buff } = await import('@strata/shared/note');
  const { pedersenHash } = await crypto();

  // Mirrors web/src/lib/keys.ts so the browser can rediscover these notes.
  const message = [
    'Strata — derive private note keys',
    '',
    'Signing this message derives the keys that control your private balance.',
    'It does not authorise any transaction and costs nothing.',
    '',
    'Only ever sign this on a site you trust.',
    'chain: 4663',
    'version: 1',
  ].join('\n');
  const seed = ethers.keccak256(await signer.signMessage(message));

  const FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const derive = (index, tag) =>
    (BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${seed}:${index}:${tag}`))) % FIELD) &
    ((1n << 248n) - 1n);

  console.log(`seeding ${COUNT} deposits of ${ethers.formatEther(denomination)} ETH`);
  console.log(`signer ${signer.address}`);

  for (let i = 0; i < COUNT; i++) {
    const nullifier = derive(i, 'nullifier');
    const secret = derive(i, 'secret');
    const bytes = new Uint8Array(62);
    bytes.set(leInt2Buff(nullifier, 31), 0);
    bytes.set(leInt2Buff(secret, 31), 31);
    const commitment = pedersenHash(bytes);
    const tx = await pool.deposit(ethers.toBeHex(commitment, 32), { value: denomination });
    await tx.wait();
    console.log(`  ${i + 1}/${COUNT}`);
  }

  console.log(`\nunspent notes : ${await pool.unspentNotes()}`);
  console.log(`pool balance  : ${ethers.formatEther(await ethers.provider.getBalance(info.contracts.pool))} ETH`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message ?? e);
    process.exit(1);
  },
);
