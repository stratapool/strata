/**
 * Publishes the contract sources to Blockscout so the deployed bytecode can be
 * checked against this repository by anyone, without asking us.
 *
 *   npx hardhat compile
 *   node scripts/verify-blockscout.mjs
 *   node scripts/verify-blockscout.mjs --only PrivacyPool
 *
 * Written rather than using hardhat-verify because that plugin is mid-migration
 * to the Etherscan v2 API and routes past `customChains` to etherscan.io, which
 * answers a Blockscout request with an HTML error page. Blockscout's own
 * endpoint takes the standard JSON input solc was actually given, which is a
 * shorter and more literal claim: these exact sources, these exact settings.
 *
 * The compiler settings are load-bearing. Verification only succeeds if solc
 * 0.8.28 with the optimizer at 200 runs and viaIR off reproduces the bytecode
 * on chain — so a future change to any of them shows up here as a failure
 * rather than as a quietly unverifiable deployment.
 *
 * The MiMC hasher is deliberately absent. It has no Solidity source: the
 * deployment generates its bytecode with circomlibjs, so there is nothing for a
 * source verifier to compile. Reproducing it is a separate instruction, printed
 * at the end.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_INFO = path.join(HERE, '..', 'artifacts', 'build-info');
const API = 'https://robinhoodchain.blockscout.com/api/v2/smart-contracts';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const line = (s = '') => console.log(s);

/** Deployed addresses and the source each was compiled from. */
const TARGETS = [
  {
    name: 'Groth16Verifier',
    address: '0x57254c611587343958EAbB70993b85Bc7948524F',
    file: 'contracts/Verifier.sol',
    // No constructor arguments.
    args: '',
  },
  {
    name: 'PrivacyPool',
    address: '0x4daA62B28c4529479785892443E0a0DFe392f460',
    file: 'contracts/PrivacyPool.sol',
    // abi.encode(verifier, hasher, denomination, levels) — the deploy script's
    // Pool.deploy(verifierAddr, hasherAddr, DENOMINATION, LEVELS).
    args:
      '00000000000000000000000057254c611587343958eabb70993b85bc7948524f' +
      '0000000000000000000000004aee710cc6d536f2064bd1ca194b5bb0d54ff97f' +
      '000000000000000000000000000000000000000000000000002386f26fc10000' +
      '0000000000000000000000000000000000000000000000000000000000000014',
  },
];

async function deployedCode(address) {
  const r = await fetch('https://stratapool.xyz/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getCode',
      params: [address, 'latest'],
    }),
  }).then((x) => x.json());
  return r.result;
}

/**
 * The build whose bytecode is the one actually on chain.
 *
 * Hardhat keeps one build per source set it has compiled and they are not
 * interchangeable: Solidity embeds a hash of the metadata, which covers the
 * list of sources compiled together, so the same contract built alongside
 * different files yields different bytecode. Taking the first match submitted
 * sources that never produced the deployed code, and it was rejected.
 *
 * Immutables are masked out of the comparison. `verifier` and `hasher` are
 * immutable, so the compiler leaves zeroed holes where the constructor writes
 * the real addresses. Comparing without masking fails at the first of them —
 * byte 552, which is the verifier's address — and reports that the contract
 * does not match its own source, which is alarming and wrong. Finding that out
 * by hand is the reason this function exists rather than a filename.
 */
async function buildFor(sourceFile, contractName, address) {
  const candidates = [];
  for (const f of await readdir(BUILD_INFO)) {
    const b = JSON.parse(await readFile(path.join(BUILD_INFO, f), 'utf8'));
    const c = b.output?.contracts?.[sourceFile]?.[contractName];
    if (c) candidates.push({ file: f, input: b.input, solc: b.solcLongVersion, evm: c.evm });
  }
  if (!candidates.length) {
    throw new Error(`no build info contains ${sourceFile}:${contractName} — run npx hardhat compile`);
  }

  const mask = (hex, refs) => {
    const a = [...hex];
    for (const spots of Object.values(refs ?? {})) {
      for (const { start, length } of spots) {
        for (let i = start * 2; i < (start + length) * 2; i++) a[i] = '0';
      }
    }
    return a.join('');
  };

  const on = (await deployedCode(address)).replace(/^0x/, '');
  for (const c of candidates) {
    const local = c.evm.deployedBytecode.object;
    if (local.length !== on.length) continue;
    const refs = c.evm.deployedBytecode.immutableReferences;
    if (mask(local, refs) === mask(on, refs)) return c;
  }
  throw new Error(
    `none of the ${candidates.length} local builds of ${contractName} reproduce the deployed ` +
      'bytecode — the source in this repository is not what is running',
  );
}

async function verify(target) {
  const { input, solc, file } = await buildFor(target.file, target.name, target.address);
  line(`\n${target.name}  ${target.address}`);
  line(`  build ${file.slice(0, 12)} reproduces the deployed bytecode`);
  line(`  solc v${solc} · optimizer ${input.settings.optimizer.enabled ? `on/${input.settings.optimizer.runs}` : 'off'} · viaIR ${!!input.settings.viaIR}`);

  const already = await fetch(`${API}/${target.address}`).then((r) => r.json());
  if (already.is_verified) {
    line('  already verified — nothing to do');
    return true;
  }

  const body = new FormData();
  body.append('compiler_version', `v${solc}`);
  body.append('contract_name', `${target.file}:${target.name}`);
  body.append('files[0]', new Blob([JSON.stringify(input)], { type: 'application/json' }), 'input.json');
  body.append('autodetect_constructor_args', 'false');
  body.append('constructor_args', target.args);
  body.append('license_type', 'mit');

  const res = await fetch(
    `${API}/${target.address}/verification/via/standard-input`,
    { method: 'POST', body },
  );
  const text = await res.text();
  if (!res.ok) {
    line(`  submit failed (${res.status}): ${text.slice(0, 300)}`);
    return false;
  }
  line(`  submitted: ${text.slice(0, 120)}`);

  // Blockscout verifies asynchronously; the POST only queues it.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const state = await fetch(`${API}/${target.address}`).then((r) => r.json());
    if (state.is_verified) {
      line(`  ✓ verified — https://robinhoodchain.blockscout.com/address/${target.address}#code`);
      return true;
    }
  }
  line('  still not verified after two minutes; check the explorer');
  return false;
}

async function main() {
  const only = arg('only');
  let ok = true;
  for (const t of TARGETS) {
    if (only && t.name !== only) continue;
    ok = (await verify(t)) && ok;
  }

  line('\n─────────────────────────────────────────────────────────');
  line('MiMC hasher  0x4aEE710cc6d536f2064BD1Ca194B5BB0d54Ff97f');
  line('  Not verifiable from source, and not for want of trying: it has no');
  line('  Solidity source. The deployment generates its bytecode directly —');
  line('  circomlibjs mimcSpongecontract.createCode("mimcsponge", 220) — so');
  line('  there is nothing for a source verifier to compile.');
  line('');
  line('  Reproduce it instead, which settles the same question:');
  line('');
  line("    node -e \"const {mimcSpongecontract:m}=require('circomlibjs');\\");
  line('      console.log(m.createCode(\'mimcsponge\', 220))" > local.hex');
  line('    cast code 0x4aEE710cc6d536f2064BD1Ca194B5BB0d54Ff97f \\');
  line('      --rpc-url https://rpc.mainnet.chain.robinhood.com');
  line('');
  line('  The deployed code is the tail of the generated creation code.');
  line('─────────────────────────────────────────────────────────');

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n${e.message ?? e}`);
  process.exit(1);
});
