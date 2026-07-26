/**
 * Deploys the pool. Everything it creates is immutable: there is no owner, no
 * upgrade path and no pause, so re-running this produces a *new* pool with a
 * fresh, empty anonymity set rather than modifying the old one.
 *
 * Requires:
 *   DEPLOYER_KEY   private key with enough ETH for gas (~0.0005 ETH)
 *   DENOMINATION   note size in ETH, default 0.1
 *
 * Optional:
 *   VERIFIER_ADDRESS, HASHER_ADDRESS
 *     Reuse an already-deployed verifier and hasher instead of deploying new
 *     ones. Both are denomination-independent — the verifier is a function of
 *     the circuit and its proving key, the hasher of nothing at all — so a pure
 *     denomination change has no reason to redeploy them. They are ~4M of the
 *     5M gas this script otherwise spends.
 *
 *     Only pass VERIFIER_ADDRESS when the deployed verifier was generated from
 *     the current build/verification_key.json. Pairing a pool with a verifier
 *     from a different ceremony rejects every honest proof, and the pool has no
 *     owner who could point it somewhere else afterwards.
 *
 *   npx hardhat run scripts/deploy.mjs --network robinhood
 */
import hre from 'hardhat';
import { mimcSpongecontract } from 'circomlibjs';
import { writeFile } from 'node:fs/promises';

const { ethers } = hre;

const LEVELS = 20;
const DENOMINATION = ethers.parseEther(process.env.DENOMINATION || '0.1');

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('no signer: set DEPLOYER_KEY');

  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`network      ${net.name} (chainId ${net.chainId})`);
  console.log(`deployer     ${deployer.address}`);
  console.log(`balance      ${ethers.formatEther(balance)} ETH`);
  console.log(`denomination ${ethers.formatEther(DENOMINATION)} ETH`);
  console.log('');

  if (balance === 0n) throw new Error('deployer has no ETH');

  const reuseHasher = process.env.HASHER_ADDRESS;
  const reuseVerifier = process.env.VERIFIER_ADDRESS;
  const deployed = [];

  let hasherAddr;
  if (reuseHasher) {
    if ((await ethers.provider.getCode(reuseHasher)) === '0x')
      throw new Error(`no contract at HASHER_ADDRESS ${reuseHasher}`);
    hasherAddr = ethers.getAddress(reuseHasher);
    console.log(`· reusing MiMC hasher  ${hasherAddr}`);
  } else {
    console.log('· deploying MiMC hasher…');
    const Hasher = new ethers.ContractFactory(
      mimcSpongecontract.abi,
      mimcSpongecontract.createCode('mimcsponge', 220),
      deployer,
    );
    const hasher = await Hasher.deploy();
    await hasher.waitForDeployment();
    hasherAddr = await hasher.getAddress();
    deployed.push(hasher);
    console.log(`  ${hasherAddr}`);
  }

  let verifierAddr;
  if (reuseVerifier) {
    if ((await ethers.provider.getCode(reuseVerifier)) === '0x')
      throw new Error(`no contract at VERIFIER_ADDRESS ${reuseVerifier}`);
    verifierAddr = ethers.getAddress(reuseVerifier);
    console.log(`· reusing verifier     ${verifierAddr}`);
    console.log('  ⚠ this must be the verifier generated from the current');
    console.log('    build/verification_key.json. A verifier from a different');
    console.log('    ceremony rejects every honest proof, and this pool will');
    console.log('    have no owner who could repoint it.');
  } else {
    console.log('· deploying Groth16 verifier…');
    const Verifier = await ethers.getContractFactory('Groth16Verifier');
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();
    verifierAddr = await verifier.getAddress();
    deployed.push(verifier);
    console.log(`  ${verifierAddr}`);
  }

  console.log('· deploying PrivacyPool…');
  const Pool = await ethers.getContractFactory('PrivacyPool');
  const pool = await Pool.deploy(verifierAddr, hasherAddr, DENOMINATION, LEVELS);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`  ${poolAddr}`);

  // Sanity: the deployed tree must start at the same empty root the JS client
  // will compute, or the very first withdrawal proof will be rejected.
  const { crypto, MerkleTree } = await import('@strata/shared/note');
  const { hashLeftRight } = await crypto();
  const emptyTree = new MerkleTree(LEVELS, hashLeftRight);
  const onchainRoot = await pool.getLastRoot();
  const jsRoot = ethers.toBeHex(emptyTree.root(), 32);
  if (onchainRoot.toLowerCase() !== jsRoot.toLowerCase()) {
    throw new Error(
      `empty-root mismatch — contract ${onchainRoot} vs client ${jsRoot}. ` +
        'Do not use this deployment; the client and contract disagree about the tree.',
    );
  }
  console.log('\n✓ empty root matches the client implementation');

  // Report gas units, not just the local ETH figure: hardhat's simulated gas
  // price bears no relation to Robinhood Chain's ~0.062 gwei, so the ETH
  // number from a dry run is meaningless for budgeting.
  const receipts = await Promise.all(
    [...deployed, pool].map((c) =>
      ethers.provider.getTransactionReceipt(c.deploymentTransaction().hash),
    ),
  );
  const gasUnits = receipts.reduce((a, r) => a + r.gasUsed, 0n);
  const spent = balance - (await ethers.provider.getBalance(deployer.address));
  console.log(`✓ gas used: ${gasUnits.toLocaleString()} units`);
  console.log(`  this run: ${ethers.formatEther(spent)} ETH`);
  console.log(
    `  at 0.062 gwei: ~${ethers.formatEther(gasUnits * 62_000_000n)} ETH`,
  );

  const info = {
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    denomination: DENOMINATION.toString(),
    levels: LEVELS,
    contracts: { pool: poolAddr, verifier: verifierAddr, hasher: hasherAddr },
    deployBlock: await ethers.provider.getBlockNumber(),
  };
  await writeFile(
    new URL(`../deployments/${net.chainId}.json`, import.meta.url),
    JSON.stringify(info, null, 2),
  );

  console.log('\n--- relayer/.env ---');
  console.log(`POOL_ADDRESS=${poolAddr}`);
  console.log(`CHAIN_ID=${net.chainId}`);
  console.log('\n--- web/.env ---');
  console.log(`VITE_POOL_ADDRESS=${poolAddr}`);
  console.log(`VITE_CHAIN_ID=${net.chainId}`);
  console.log(`VITE_DEPLOY_BLOCK=${info.deployBlock}`);
  console.log('\n⚠ Unaudited, uncapped, and not pausable or upgradeable.');
  console.log('  Nothing in the contract limits what a circuit bug could take,');
  console.log('  so the interface disclosure is the only protection users have.');
  console.log('  The phase-2 ceremony must be public before this holds anyone');
  console.log('  else\'s money.');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message ?? e);
    process.exit(1);
  },
);
