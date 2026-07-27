/**
 * Compiles the withdraw circuit.
 *
 * This script was missing. `package.json` referenced it, `setup.mjs` told you
 * to run it first, and the README asked people to check hashes it produces —
 * while the only way to obtain `build/withdraw.r1cs` was to already have it.
 * The artefacts in the repository were reproducible, but nobody outside could
 * demonstrate that, which is the whole point of publishing the hashes.
 *
 * It matters more now than it did: contributors to the phase-2 ceremony are
 * injecting randomness into parameters for *this* circuit, and the only way to
 * confirm which circuit that is, is to compile it and compare.
 *
 * The compiler version is checked rather than assumed. circom's output is not
 * guaranteed stable across versions, so a different one silently produces a
 * different r1cs — and then a hash mismatch that looks like tampering.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const SRC = path.join(ROOT, 'circuits', 'withdraw.circom');

/** The version the committed artefacts and the README hashes were produced with. */
const EXPECTED_CIRCOM = '2.2.3';

const sha256 = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

function circomVersion() {
  try {
    const out = execFileSync('circom', ['--version'], { encoding: 'utf8' });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

function main() {
  const version = circomVersion();
  if (!version) {
    throw new Error(
      'circom is not on PATH. Install it from https://docs.circom.io — the npm\n' +
        'package named "circom" is the abandoned 0.5 line and will not compile this.',
    );
  }
  console.log(`· circom ${version}`);
  if (version !== EXPECTED_CIRCOM) {
    console.warn(
      `\n⚠ The committed artefacts and the hashes in the README were built with\n` +
        `  circom ${EXPECTED_CIRCOM}. Output is not guaranteed identical across\n` +
        `  versions, so a mismatch below is more likely this than tampering.\n`,
    );
  }

  mkdirSync(BUILD, { recursive: true });
  console.log('· compiling…');
  execFileSync(
    'circom',
    [SRC, '--r1cs', '--wasm', '--sym', '-o', BUILD, '-l', path.join(ROOT, 'node_modules')],
    { stdio: 'inherit' },
  );

  const outputs = {
    'withdraw.r1cs': path.join(BUILD, 'withdraw.r1cs'),
    'withdraw.wasm': path.join(BUILD, 'withdraw_js', 'withdraw.wasm'),
    'withdraw.circom': SRC,
    'merkleTree.circom': path.join(ROOT, 'circuits', 'merkleTree.circom'),
  };

  console.log('\nSHA-256 — compare these against the manifest in the README:');
  for (const [name, file] of Object.entries(outputs)) {
    if (!existsSync(file)) throw new Error(`expected output missing: ${file}`);
    console.log(`  ${name.padEnd(20)} ${sha256(file)}`);
  }

  console.log('\nNext: npm run setup');
  console.log('Note that the proving key is NOT reproducible — the phase-2');
  console.log('contribution is random, so setup.mjs produces a different zkey');
  console.log('every run. Only the r1cs and wasm above should match.');
}

main();
