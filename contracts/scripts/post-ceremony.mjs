/**
 * Everything between a finalised ceremony and a live pool running its key.
 *
 *   DEPLOYER_KEY=0x… node scripts/post-ceremony.mjs
 *   DEPLOYER_KEY=0x… node scripts/post-ceremony.mjs --dry-run
 *
 * finalise.mjs produces the key. This turns it into a deployment: names the
 * served artefacts after their hashes, deploys a verifier and a pool against
 * them, and writes the two env files that point the site and the relayer at
 * the result.
 *
 * Scripted because it is a sequence with one ordering that works and several
 * that fail quietly. The verifier must be redeployed — it is generated from
 * the key, and a pool wired to the old one rejects every honest proof. The
 * hasher must not be: it is a function of nothing, and redeploying it wastes
 * 4M gas. The zkey filename must change with its contents, because it is
 * served immutable for a year and a returning visitor otherwise proves against
 * a key the chain no longer accepts, with `invalid proof` as the only symptom.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, rename, copyFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BUILD = path.join(ROOT, 'circuits', 'build');
const PUBLIC = path.join(ROOT, 'web', 'public', 'circuit');
const CHAIN_ID = 4663;

const flag = (n) => process.argv.includes(`--${n}`);
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const line = (s = '') => console.log(s);

/** Reused across denominations and ceremonies: it depends on neither. */
const HASHER = '0x4aEE710cc6d536f2064BD1Ca194B5BB0d54Ff97f';

async function main() {
  if (!process.env.DEPLOYER_KEY) throw new Error('set DEPLOYER_KEY');

  const zkey = path.join(BUILD, 'withdraw_final.zkey');
  const wasm = path.join(BUILD, 'withdraw_js', 'withdraw.wasm');
  const vkey = path.join(BUILD, 'verification_key.json');
  for (const f of [zkey, wasm, vkey]) {
    if (!existsSync(f)) throw new Error(`missing ${f} — run finalise.mjs first`);
  }

  // Guard against deploying a key the ceremony has not actually closed on.
  const status = await (await fetch('https://stratapool.xyz/ceremony/status')).json();
  if (!status.finalised) {
    throw new Error(
      'the ceremony reports it is not finalised. Deploying now would put a ' +
        'key into production that the beacon has not been applied to.',
    );
  }

  const zkeyHash = sha256(zkey);
  const wasmHash = sha256(wasm);
  line(`zkey  ${zkeyHash}`);
  line(`wasm  ${wasmHash}`);
  line(`vkey  ${sha256(vkey)}`);

  const zkeyName = `withdraw_final.${zkeyHash.slice(0, 8)}.zkey`;
  const wasmName = `withdraw.${wasmHash.slice(0, 8)}.wasm`;

  if (flag('dry-run')) {
    line('\n--dry-run: would publish as');
    line(`  ${zkeyName}`);
    line(`  ${wasmName}`);
    line('and deploy a verifier + pool, reusing the hasher.');
    return;
  }

  // ------------------------------------------------------- served artefacts
  // Cleared rather than added to: leaving the previous key served under its own
  // name means a stale bookmark or a cached index keeps working against a pool
  // that no longer accepts it.
  for (const f of await readdir(PUBLIC)) {
    if (/\.(zkey|wasm)$/.test(f)) await rename(path.join(PUBLIC, f), path.join(PUBLIC, `${f}.old`));
  }
  for (const f of await readdir(PUBLIC)) {
    if (f.endsWith('.old')) await import('node:fs/promises').then((m) => m.rm(path.join(PUBLIC, f)));
  }
  await copyFile(zkey, path.join(PUBLIC, zkeyName));
  await copyFile(wasm, path.join(PUBLIC, wasmName));
  await copyFile(vkey, path.join(PUBLIC, 'verification_key.json'));
  line(`\n· published ${zkeyName} and ${wasmName}`);

  // -------------------------------------------------------------- deploy
  line('· deploying verifier and pool (hasher reused)…');
  execFileSync(
    'npx',
    ['hardhat', 'run', 'scripts/deploy.mjs', '--network', 'robinhood'],
    {
      cwd: path.join(ROOT, 'contracts'),
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, DENOMINATION: '0.01', HASHER_ADDRESS: HASHER },
    },
  );

  const info = JSON.parse(
    await readFile(path.join(HERE, '..', 'deployments', `${CHAIN_ID}.json`), 'utf8'),
  );

  // ----------------------------------------------------------------- env
  const webEnv = [
    `VITE_POOL_ADDRESS=${info.contracts.pool}`,
    `VITE_CHAIN_ID=${CHAIN_ID}`,
    `VITE_DEPLOY_BLOCK=${info.deployBlock}`,
    'VITE_RPC_URL=https://rpc.mainnet.chain.robinhood.com',
    'VITE_RELAYER_URL=/relayer',
    `VITE_CIRCUIT_WASM=/circuit/${wasmName}`,
    `VITE_CIRCUIT_ZKEY=/circuit/${zkeyName}`,
    'VITE_REOWN_PROJECT_ID=ff0ff3c6373af8a09c7cb958e6312eac',
    '',
  ].join('\n');
  await writeFile(path.join(ROOT, 'web', '.env'), webEnv);
  line('\n· wrote web/.env');

  line('\n─────────────────────────────────────────────────────────');
  line(`pool      ${info.contracts.pool}`);
  line(`verifier  ${info.contracts.verifier}`);
  line(`hasher    ${info.contracts.hasher}  (reused)`);
  line(`block     ${info.deployBlock}`);
  line('\nStill to do by hand — each touches the live host:');
  line('  1. relayer .env: POOL_ADDRESS, then rebuild the image');
  line('     (the verification key is baked in; restarting is not enough)');
  line('  2. web: npm run build, upload dist');
  line('  3. README: addresses, the manifest above, and the trusted-setup');
  line('     section, which can finally say what happened');
  line('─────────────────────────────────────────────────────────');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\n${e.message ?? e}`);
    process.exit(1);
  },
);
