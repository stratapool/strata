/**
 * Closes the ceremony with the drand beacon that was announced when it opened.
 *
 *   node scripts/finalise.mjs --round 6362166
 *   node scripts/finalise.mjs --round 6362166 --dry-run
 *
 * The beacon does not replace an honest contributor and nothing here pretends
 * otherwise. What it removes is the last thing the operator would have to be
 * trusted about: a final contribution chosen by us could have been ground —
 * tried a thousand times and the convenient one kept — and nobody could tell.
 * A drand round published before its value exists cannot be shopped for, and
 * anyone can fetch the same value afterwards and rebuild this key themselves.
 *
 * Written ahead of the date on purpose. The alternative is recalling a
 * multi-step sequence under time pressure on the one occasion where a mistake
 * strands the whole ceremony.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const R1CS = path.join(BUILD, 'withdraw.r1cs');
const PTAU = path.join(BUILD, 'pot16_final.ptau');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const ROUND = Number(arg('round', 0));
const CEREMONY_URL = arg('ceremony', 'https://stratapool.xyz/ceremony');
const DRAND = arg('drand', 'https://api.drand.sh');

/**
 * snarkjs applies the beacon by hashing this hex string, so it must be the
 * randomness itself — not a hash of it, and not the round number. Anyone
 * re-deriving the key later fetches the same value from drand and gets the
 * same result; a different encoding here silently makes that impossible.
 */
async function beaconRandomness(round) {
  const res = await fetch(`${DRAND}/public/${round}`);
  if (!res.ok) {
    throw new Error(
      `drand round ${round} is not available yet (HTTP ${res.status}). ` +
        'It is published on a fixed schedule; wait for it rather than ' +
        'substituting another round.',
    );
  }
  const body = await res.json();
  if (Number(body.round) !== round) {
    throw new Error(`asked for round ${round}, drand returned ${body.round}`);
  }
  if (!/^[0-9a-f]{64}$/.test(body.randomness ?? '')) {
    throw new Error(`round ${round} has no usable randomness`);
  }
  return body;
}

const sha256 = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

async function main() {
  if (!ROUND) throw new Error('pass --round <n>, the round announced when the ceremony opened');

  // ---------------------------------------------------------------- checks
  for (const f of [R1CS, PTAU]) {
    if (!existsSync(f)) throw new Error(`missing ${f} — run npm run build first`);
  }

  const status = await (await fetch(`${CEREMONY_URL}/status`)).json();
  if (status.finalised) {
    throw new Error('the ceremony is already finalised');
  }
  if (status.drandRound !== ROUND) {
    throw new Error(
      `the ceremony announced round ${status.drandRound}, not ${ROUND}. ` +
        'Finalising on a different round is exactly the thing announcing one ' +
        'in advance was meant to prevent.',
    );
  }
  if (!status.contributions) {
    throw new Error('no contributions — finalising now would produce a key nobody touched');
  }

  console.log(`· ceremony has ${status.contributions} contributions`);
  console.log(`· fetching drand round ${ROUND}…`);
  const beacon = await beaconRandomness(ROUND);
  console.log(`  randomness ${beacon.randomness}`);

  // ------------------------------------------------------------- the key
  const contributed = path.join(BUILD, 'ceremony_contributed.zkey');
  console.log('· downloading the contributed key…');
  const bytes = Buffer.from(await (await fetch(`${CEREMONY_URL}/zkey`)).arrayBuffer());
  await mkdir(BUILD, { recursive: true });
  await writeFile(contributed, bytes);
  console.log(`  ${(bytes.length / 1024 / 1024).toFixed(2)} MB  sha256 ${sha256(contributed)}`);

  console.log('· verifying it before touching it…');
  if (!(await snarkjs.zKey.verifyFromR1cs(R1CS, PTAU, contributed))) {
    throw new Error('the contributed key does not verify — refusing to finalise');
  }

  if (flag('dry-run')) {
    console.log('\n--dry-run: stopping before the beacon is applied.');
    return;
  }

  const final = path.join(BUILD, 'withdraw_final.zkey');
  const beaconed = path.join(BUILD, 'ceremony_beaconed.zkey');
  console.log('· applying the beacon…');
  // 10 iterations of the VDF, matching what every published ceremony uses.
  await snarkjs.zKey.beacon(contributed, beaconed, `drand-${ROUND}`, beacon.randomness, 10);

  console.log('· verifying the finalised key…');
  if (!(await snarkjs.zKey.verifyFromR1cs(R1CS, PTAU, beaconed))) {
    throw new Error('the beaconed key does not verify — do not deploy it');
  }

  // Only now does the file the rest of the repo reads get replaced. Writing it
  // first and verifying after would leave a broken key in place on failure.
  await copyFile(beaconed, final);

  console.log('· exporting verification key and Solidity verifier…');
  const vkey = await snarkjs.zKey.exportVerificationKey(final);
  await writeFile(path.join(BUILD, 'verification_key.json'), JSON.stringify(vkey, null, 2));
  const templates = {
    groth16: await readFile(
      path.join(ROOT, 'node_modules/snarkjs/templates/verifier_groth16.sol.ejs'),
      'utf8',
    ),
  };
  await writeFile(
    path.join(ROOT, '..', 'contracts', 'contracts', 'Verifier.sol'),
    await snarkjs.zKey.exportSolidityVerifier(final, templates),
  );

  console.log('\n─────────────────────────────────────────────────────────');
  console.log('Finalised. Record these — the README manifest needs them.\n');
  for (const [name, file] of [
    ['withdraw_final.zkey', final],
    ['verification_key.json', path.join(BUILD, 'verification_key.json')],
    ['Verifier.sol', path.join(ROOT, '..', 'contracts', 'contracts', 'Verifier.sol')],
  ]) {
    console.log(`  ${name.padEnd(22)} ${sha256(file)}`);
  }
  console.log(`\n  drand round      ${ROUND}`);
  console.log(`  randomness       ${beacon.randomness}`);
  console.log(`  contributions    ${status.contributions}`);
  console.log('\nNext:');
  console.log('  1. rename the served key to withdraw_final.<first 8 hex>.zkey');
  console.log('     — it is cached immutable for a year, so a changed key under');
  console.log('       the old name hands every returning visitor a retired one');
  console.log('  2. deploy: DEPLOYER_KEY=0x… HASHER_ADDRESS=0x4aEE710c… \\');
  console.log('       npx hardhat run scripts/deploy.mjs --network robinhood');
  console.log('     — no VERIFIER_ADDRESS: the verifier changed with the key');
  console.log('  3. point web/.env and the relayer at the new pool, rebuild both');
  console.log('  4. rewrite the trusted-setup section of the README');
  console.log('─────────────────────────────────────────────────────────');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\n${e.message ?? e}`);
    process.exit(1);
  },
);
