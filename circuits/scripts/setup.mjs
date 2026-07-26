/**
 * Trusted setup for the withdraw circuit.
 *
 * Phase 1 comes from the Perpetual Powers of Tau — a ceremony with thousands
 * of participants that we do not have to run. Phase 2 is circuit-specific and
 * DOES have to be run, publicly, before mainnet.
 *
 * The stakes are worth restating: whoever holds the phase-2 toxic waste can
 * forge proofs and drain the entire pool, and a forged proof is indistinguish-
 * able on-chain from a real one. This script's --dev mode generates that waste
 * locally and throws it away unceremoniously; keys it produces are for local
 * testing ONLY and must never be deployed.
 */
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const POWER = 16; // 2^16 = 65,536 ≥ 36,451 constraints
const PTAU_URL = `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${POWER}.ptau`;
const PTAU = path.join(BUILD, `pot${POWER}_final.ptau`);
const DEV = process.argv.includes('--dev');

mkdirSync(BUILD, { recursive: true });

async function ensurePtau() {
  if (existsSync(PTAU)) {
    console.log(`· ptau already present: ${path.basename(PTAU)}`);
    return;
  }

  if (!DEV) {
    console.log(`· downloading Perpetual Powers of Tau (2^${POWER})…`);
    const res = await fetch(PTAU_URL);
    if (!res.ok) throw new Error(`ptau download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(PTAU));
    console.log('· ptau downloaded');
    return;
  }

  console.log('');
  console.log('  ############################################################');
  console.log('  #  --dev: generating phase 1 LOCALLY.                      #');
  console.log('  #  The toxic waste exists on this machine. Anything built  #');
  console.log('  #  from it can be forged. LOCAL TESTING ONLY.              #');
  console.log('  ############################################################');
  console.log('');

  const { getCurveFromName } = await import('ffjavascript');
  const curve = await getCurveFromName('bn128');
  const tmp0 = path.join(BUILD, '_pot_0000.ptau');
  const tmp1 = path.join(BUILD, '_pot_0001.ptau');
  await snarkjs.powersOfTau.newAccumulator(curve, POWER, tmp0);
  await snarkjs.powersOfTau.contribute(tmp0, tmp1, 'dev', 'insecure-dev-entropy');
  await snarkjs.powersOfTau.preparePhase2(tmp1, PTAU);
  await curve.terminate();
  console.log('· local ptau ready (INSECURE)');
}

async function main() {
  const r1cs = path.join(BUILD, 'withdraw.r1cs');
  if (!existsSync(r1cs)) throw new Error('compile the circuit first: npm run build');

  await ensurePtau();

  const zkey0 = path.join(BUILD, 'withdraw_0000.zkey');
  const zkeyFinal = path.join(BUILD, 'withdraw_final.zkey');

  console.log('· groth16 setup…');
  await snarkjs.zKey.newZKey(r1cs, PTAU, zkey0);

  // A real launch replaces this with a public, multi-participant ceremony
  // whose transcript is published. See docs/design/privacy-pool.md §4.3.
  console.log('· phase 2 contribution…');
  await snarkjs.zKey.contribute(
    zkey0,
    zkeyFinal,
    'strata-dev',
    DEV ? 'insecure-dev-entropy' : String(Date.now()) + Math.random(),
  );

  console.log('· exporting verification key…');
  const vkey = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
  await writeFile(
    path.join(BUILD, 'verification_key.json'),
    JSON.stringify(vkey, null, 2),
  );

  console.log('· exporting Solidity verifier…');
  const templates = {
    groth16: await readFile(
      path.join(ROOT, 'node_modules/snarkjs/templates/verifier_groth16.sol.ejs'),
      'utf8',
    ),
  };
  const sol = await snarkjs.zKey.exportSolidityVerifier(zkeyFinal, templates);
  const outDir = path.join(ROOT, '..', 'contracts', 'contracts');
  mkdirSync(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'Verifier.sol'), sol);

  console.log('');
  console.log(`✓ verification key : build/verification_key.json`);
  console.log(`✓ proving key      : build/withdraw_final.zkey`);
  console.log(`✓ solidity verifier: contracts/contracts/Verifier.sol`);
  if (DEV) console.log('\n⚠ DEV KEYS — NOT FOR DEPLOYMENT');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
