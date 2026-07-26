import { copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { CeremonyState, sha256File } from './state.js';
import { readChain } from './chain.js';
import { createServer } from './server.js';

/**
 * Starts from an existing key rather than creating one.
 *
 * SEED_ZKEY is copied in only when there is nothing to continue, so a restart
 * never resets a ceremony in progress — the transcript and the chain would
 * disagree instantly, and every later upload would be rejected as a fork.
 */
async function main() {
  const cfg = loadConfig();
  const state = new CeremonyState(cfg.DATA_DIR);
  await state.load();

  const exists = await access(state.currentZkeyPath).then(() => true, () => false);
  if (!exists) {
    const seed = process.env.SEED_ZKEY;
    if (!seed) {
      throw new Error(
        `no key at ${state.currentZkeyPath} and SEED_ZKEY is unset — point it at ` +
          'the phase-2 key the ceremony should build on',
      );
    }
    if (state.count() > 0) {
      throw new Error(
        'the transcript records contributions but the key is missing. Restore ' +
          'it rather than seeding: seeding now would fork the chain and erase ' +
          `all ${state.count()} of them.`,
      );
    }
    await copyFile(seed, state.currentZkeyPath);
    console.log(`· seeded from ${seed}`);
  }

  const report = await readChain(state.currentZkeyPath, cfg.R1CS_PATH, cfg.PTAU_PATH);
  if (!report.valid) {
    throw new Error('the key on disk does not verify against the circuit — refusing to start');
  }
  // On a restart the chain and the transcript must already agree. Serving a
  // key that has contributions the transcript has never heard of would reject
  // every honest upload from then on.
  if (report.contributions.length !== state.count()) {
    throw new Error(
      `the key holds ${report.contributions.length} contributions but the transcript ` +
        `records ${state.count()} — refusing to start on a disagreement`,
    );
  }

  await state.begin(report.circuitHash, cfg.DRAND_ROUND ?? null);

  const sha = await sha256File(state.currentZkeyPath);
  console.log('');
  console.log(`data dir      ${path.resolve(cfg.DATA_DIR)}`);
  console.log(`circuit hash  ${report.circuitHash?.slice(0, 32)}…`);
  console.log(`contributions ${state.count()}`);
  console.log(`current zkey  ${sha}`);
  console.log(`slot ttl      ${cfg.SLOT_TTL_SECONDS}s`);
  console.log(
    `drand round   ${cfg.DRAND_ROUND ?? '(unset — announce it before opening)'}`,
  );
  if (!cfg.DRAND_ROUND) {
    console.warn('');
    console.warn('⚠ No DRAND_ROUND announced. A beacon chosen after the fact still');
    console.warn('  has to be trusted; one published in advance does not. Set it');
    console.warn('  before inviting anyone.');
  }

  const app = createServer(cfg, state);
  app.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`\nlistening on http://${cfg.HOST}:${cfg.PORT}`);
  });
}

main().catch((e) => {
  console.error(`\n${e.message ?? e}`);
  process.exit(1);
});
