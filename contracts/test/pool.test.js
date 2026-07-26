const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const path = require('node:path');
const { mimcSpongecontract } = require('circomlibjs');

const LEVELS = 20;
const DENOMINATION = ethers.parseEther('0.1');
const CIRCUITS = path.resolve(__dirname, '../../circuits/build');
const WASM = path.join(CIRCUITS, 'withdraw_js/withdraw.wasm');
const ZKEY = path.join(CIRCUITS, 'withdraw_final.zkey');

let noteLib, proofLib;

before(async () => {
  noteLib = await import('@strata/shared/note');
  proofLib = await import('@strata/shared/proof');
});

async function deployPool() {
  const [deployer, alice, relayer] = await ethers.getSigners();

  const Hasher = new ethers.ContractFactory(
    mimcSpongecontract.abi,
    mimcSpongecontract.createCode('mimcsponge', 220),
    deployer,
  );
  const hasher = await Hasher.deploy();

  const Verifier = await ethers.getContractFactory('Groth16Verifier');
  const verifier = await Verifier.deploy();

  const Pool = await ethers.getContractFactory('PrivacyPool');
  const pool = await Pool.deploy(
    await verifier.getAddress(),
    await hasher.getAddress(),
    DENOMINATION,
    LEVELS,
  );

  return { pool, hasher, verifier, deployer, alice, relayer };
}

/** Rebuild the tree from chain events, exactly as a real client must. */
async function treeFromChain(pool) {
  const { crypto, MerkleTree } = noteLib;
  const { hashLeftRight } = await crypto();
  const events = await pool.queryFilter(pool.filters.Deposit(), 0, 'latest');
  const leaves = events
    .sort((a, b) => Number(a.args.leafIndex) - Number(b.args.leafIndex))
    .map((e) => BigInt(e.args.commitment));
  return new MerkleTree(LEVELS, hashLeftRight, leaves);
}

/**
 * Uses the shared proof builder rather than a local copy, so the G2 coordinate
 * swap in @strata/shared/proof is validated against a real on-chain Groth16
 * verifier — the strongest check available on that transpose.
 */
async function proveWithdrawal({ note, tree, leafIndex, recipient, relayer }) {
  const { proof, root } = await proofLib.proveWithdrawal({
    note,
    tree,
    leafIndex,
    recipient,
    relayer,
    wasmPath: WASM,
    zkeyPath: ZKEY,
  });
  return { a: proof.a, b: proof.b, c: proof.c, root };
}

describe('PrivacyPool', () => {
  describe('hasher', () => {
    it('on-chain MiMC agrees with circomlibjs', async () => {
      // Guards the bug this suite was first written against: current
      // circomlibjs emits MiMCSponge(xL, xR, k) while Tornado was built for
      // the two-argument form. Declaring the old signature compiles cleanly
      // and then dies at runtime on a selector that does not exist.
      const { hasher } = await deployPool();
      const { buildMimcSponge } = await import('circomlibjs');
      const mimc = await buildMimcSponge();

      for (const [xL, xR] of [[1n, 2n], [0n, 0n], [12345n, 67890n]]) {
        const onchain = await hasher.MiMCSponge(xL, xR, 0n);
        const expected = mimc.hash(xL, xR, 0n);
        expect(onchain[0]).to.equal(BigInt(mimc.F.toString(expected.xL)));
        expect(onchain[1]).to.equal(BigInt(mimc.F.toString(expected.xR)));
      }
    });
  });

  describe('deposit', () => {
    it('accepts a correctly-sized deposit and grows the anonymity set', async () => {
      const { pool } = await deployPool();
      const note = await noteLib.createNote();

      await expect(pool.deposit(ethers.toBeHex(note.commitment, 32), { value: DENOMINATION }))
        .to.emit(pool, 'Deposit');

      expect(await pool.unspentNotes()).to.equal(1n);
      expect(await pool.isSolvent()).to.equal(true);
    });

    it('rejects any amount other than the denomination', async () => {
      const { pool } = await deployPool();
      const note = await noteLib.createNote();
      const commitment = ethers.toBeHex(note.commitment, 32);

      await expect(
        pool.deposit(commitment, { value: DENOMINATION - 1n }),
      ).to.be.revertedWith('wrong denomination');
      await expect(
        pool.deposit(commitment, { value: DENOMINATION + 1n }),
      ).to.be.revertedWith('wrong denomination');
    });

    it('rejects a duplicate commitment', async () => {
      // Otherwise a griefer front-runs a deposit with the same commitment and
      // one of the two deposits is stranded forever.
      const { pool } = await deployPool();
      const note = await noteLib.createNote();
      const commitment = ethers.toBeHex(note.commitment, 32);

      await pool.deposit(commitment, { value: DENOMINATION });
      await expect(
        pool.deposit(commitment, { value: DENOMINATION }),
      ).to.be.revertedWith('commitment already used');
    });

    it('starts at the same empty root the client computes', async () => {
      // Caught during the first deploy dry-run: the contract seeded roots[0]
      // with zeros(levels-1) while a leaf-at-level-0 tree of depth `levels`
      // has its root at zeros(levels). Every post-insert root still agreed,
      // so no other test noticed — the divergence only existed before the
      // first deposit.
      const { pool } = await deployPool();
      const { crypto, MerkleTree } = noteLib;
      const { hashLeftRight } = await crypto();
      const empty = new MerkleTree(LEVELS, hashLeftRight);

      expect(await pool.getLastRoot()).to.equal(ethers.toBeHex(empty.root(), 32));
    });

    it('matches the JS merkle root against the contract root', async () => {
      // Three independent MiMC implementations (circom, Solidity, JS) must
      // agree. If they drift, notes become undepositable-and-unspendable and
      // no other test would notice until a proof fails.
      const { pool } = await deployPool();
      const tree = await treeFromChain(pool);

      for (let i = 0; i < 3; i++) {
        const note = await noteLib.createNote();
        await pool.deposit(ethers.toBeHex(note.commitment, 32), { value: DENOMINATION });
        tree.insert(note.commitment);
        expect(ethers.toBeHex(tree.root(), 32)).to.equal(await pool.getLastRoot());
      }
    });
  });

  describe('capacity', () => {
    it('accepts deposits without any balance ceiling', async () => {
      // Uncapped by decision, not by omission: on a new chain the anonymity
      // set is won by whoever gets there first, and a cap throttles exactly
      // that. The cost is that a circuit bug drains everything — which is why
      // the interface's unaudited disclosure is load-bearing.
      const { pool } = await deployPool();
      const many = 60; // past where the old 5 ETH ceiling used to sit

      for (let i = 0; i < many; i++) {
        const note = await noteLib.createNote();
        await pool.deposit(ethers.toBeHex(note.commitment, 32), { value: DENOMINATION });
      }

      expect(await pool.unspentNotes()).to.equal(BigInt(many));
      expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(
        DENOMINATION * BigInt(many),
      );
      expect(await pool.isSolvent()).to.equal(true);

      // And still accepting after time passes — nothing gates on the clock.
      await time.increase(30 * 24 * 3600);
      const later = await noteLib.createNote();
      await expect(
        pool.deposit(ethers.toBeHex(later.commitment, 32), { value: DENOMINATION }),
      ).to.emit(pool, 'Deposit');
    });
  });

  describe('withdraw', () => {
    it('pays the recipient and relayer, and burns the note', async () => {
      const { pool, alice, relayer } = await deployPool();

      // Two extra deposits so the withdrawal is not trivially the only leaf.
      const tree = await treeFromChain(pool);
      const notes = [];
      for (let i = 0; i < 3; i++) {
        const n = await noteLib.createNote();
        await pool.deposit(ethers.toBeHex(n.commitment, 32), { value: DENOMINATION });
        tree.insert(n.commitment);
        notes.push(n);
      }

      const note = notes[1];
      const recipient = ethers.Wallet.createRandom().address;
      const { a, b, c, root } = await proveWithdrawal({
        note,
        tree,
        leafIndex: 1,
        recipient,
        relayer: relayer.address,
      });

      const relayerBefore = await ethers.provider.getBalance(relayer.address);

      // Submitted by an unrelated account: the proof is the authorisation,
      // not the sender.
      await pool
        .connect(alice)
        .withdraw(
          a,
          b,
          c,
          ethers.toBeHex(root, 32),
          ethers.toBeHex(note.nullifierHash, 32),
          recipient,
          relayer.address,
        );

      const relayerFee = (DENOMINATION * 20n) / 10000n;
      const reserveFee = (DENOMINATION * 10n) / 10000n;

      expect(await ethers.provider.getBalance(recipient)).to.equal(
        DENOMINATION - relayerFee - reserveFee,
      );
      expect(await ethers.provider.getBalance(relayer.address)).to.equal(
        relayerBefore + relayerFee,
      );
      expect(await pool.reserve()).to.equal(reserveFee);
      expect(await pool.isSpent(ethers.toBeHex(note.nullifierHash, 32))).to.equal(true);
      expect(await pool.unspentNotes()).to.equal(2n);
      expect(await pool.isSolvent()).to.equal(true);
    });

    it('rejects a second spend of the same note', async () => {
      const { pool, relayer } = await deployPool();
      const tree = await treeFromChain(pool);
      const note = await noteLib.createNote();
      await pool.deposit(ethers.toBeHex(note.commitment, 32), { value: DENOMINATION });
      tree.insert(note.commitment);

      const recipient = ethers.Wallet.createRandom().address;
      const { a, b, c, root } = await proveWithdrawal({
        note,
        tree,
        leafIndex: 0,
        recipient,
        relayer: relayer.address,
      });
      const args = [
        a, b, c,
        ethers.toBeHex(root, 32),
        ethers.toBeHex(note.nullifierHash, 32),
        recipient,
        relayer.address,
      ];

      await pool.withdraw(...args);
      await expect(pool.withdraw(...args)).to.be.revertedWith('note already spent');
    });

    it('rejects a proof whose recipient was tampered with', async () => {
      // The single most important property. Without the squared constraints
      // in the circuit, a relayer could rewrite this field and steal every
      // withdrawal it handled — and the proof would still verify.
      const { pool, relayer } = await deployPool();
      const tree = await treeFromChain(pool);
      const note = await noteLib.createNote();
      await pool.deposit(ethers.toBeHex(note.commitment, 32), { value: DENOMINATION });
      tree.insert(note.commitment);

      const honestRecipient = ethers.Wallet.createRandom().address;
      const { a, b, c, root } = await proveWithdrawal({
        note,
        tree,
        leafIndex: 0,
        recipient: honestRecipient,
        relayer: relayer.address,
      });

      const attacker = ethers.Wallet.createRandom().address;
      await expect(
        pool.withdraw(
          a, b, c,
          ethers.toBeHex(root, 32),
          ethers.toBeHex(note.nullifierHash, 32),
          attacker, // swapped
          relayer.address,
        ),
      ).to.be.revertedWith('invalid proof');
    });

    it('rejects an unknown merkle root', async () => {
      const { pool, relayer } = await deployPool();
      const tree = await treeFromChain(pool);
      const note = await noteLib.createNote();
      await pool.deposit(ethers.toBeHex(note.commitment, 32), { value: DENOMINATION });
      tree.insert(note.commitment);

      const recipient = ethers.Wallet.createRandom().address;
      const { a, b, c } = await proveWithdrawal({
        note, tree, leafIndex: 0, recipient, relayer: relayer.address,
      });

      await expect(
        pool.withdraw(
          a, b, c,
          ethers.toBeHex(12345n, 32), // never published
          ethers.toBeHex(note.nullifierHash, 32),
          recipient,
          relayer.address,
        ),
      ).to.be.revertedWith('unknown merkle root');
    });

    it('pays out an identical amount whether or not a relayer is used', async () => {
      // Self-withdrawals must not be a distinguishable amount, or the payout
      // itself reveals which withdrawals bypassed the relayer.
      const { pool } = await deployPool();
      const tree = await treeFromChain(pool);
      const note = await noteLib.createNote();
      await pool.deposit(ethers.toBeHex(note.commitment, 32), { value: DENOMINATION });
      tree.insert(note.commitment);

      const recipient = ethers.Wallet.createRandom().address;
      const { a, b, c, root } = await proveWithdrawal({
        note, tree, leafIndex: 0, recipient, relayer: ethers.ZeroAddress,
      });

      await pool.withdraw(
        a, b, c,
        ethers.toBeHex(root, 32),
        ethers.toBeHex(note.nullifierHash, 32),
        recipient,
        ethers.ZeroAddress,
      );

      const totalFee = (DENOMINATION * 30n) / 10000n;
      expect(await ethers.provider.getBalance(recipient)).to.equal(
        DENOMINATION - totalFee,
      );
      expect(await pool.reserve()).to.equal(totalFee);
    });
  });

  describe('note encoding', () => {
    it('round-trips through the serialised form', async () => {
      const note = await noteLib.createNote();
      const decoded = await noteLib.decodeNote(noteLib.encodeNote(note));
      expect(decoded.nullifier).to.equal(note.nullifier);
      expect(decoded.secret).to.equal(note.secret);
      expect(decoded.commitment).to.equal(note.commitment);
      expect(decoded.nullifierHash).to.equal(note.nullifierHash);
    });
  });
});
