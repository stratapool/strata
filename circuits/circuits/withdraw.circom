pragma circom 2.1.9;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/pedersen.circom";
include "merkleTree.circom";

// ---------------------------------------------------------------------------
// Strata withdraw circuit.
//
// This is Tornado Cash v1's circuit, logic unchanged. The only edits are the
// circom 1 -> 2 syntax migration: `pragma`, and moving the public/private
// split out of the signal declarations and into `component main`.
//
// It is deliberately NOT modernised. Pedersen and MiMC are slower and use more
// constraints than Poseidon, but this chain's gas is 0.062 gwei so the saving
// would be worth approximately nothing — while touching the circuit would
// forfeit the assurance inherited from the most-audited ZK code in existence.
// With no audit budget, edit count IS risk exposure.
//
// `fee` and `refund` are kept even though this protocol fixes the fee as an
// immutable contract constant. Keeping them costs four constraints and keeps
// the circuit byte-identical in behaviour; the contract simply always passes
// zero for both. Removing them would have been a change for no gain.
// ---------------------------------------------------------------------------

// computes Pedersen(nullifier + secret)
template CommitmentHasher() {
    signal input nullifier;
    signal input secret;
    signal output commitment;
    signal output nullifierHash;

    component commitmentHasher = Pedersen(496);
    component nullifierHasher = Pedersen(248);
    component nullifierBits = Num2Bits(248);
    component secretBits = Num2Bits(248);
    nullifierBits.in <== nullifier;
    secretBits.in <== secret;

    for (var i = 0; i < 248; i++) {
        nullifierHasher.in[i] <== nullifierBits.out[i];
        commitmentHasher.in[i] <== nullifierBits.out[i];
        commitmentHasher.in[i + 248] <== secretBits.out[i];
    }

    commitment <== commitmentHasher.out[0];
    nullifierHash <== nullifierHasher.out[0];
}

// Verifies that the commitment corresponding to the given secret and nullifier
// is included in the merkle tree of deposits.
template Withdraw(levels) {
    signal input root;
    signal input nullifierHash;
    signal input recipient; // not taking part in any computations
    signal input relayer;   // not taking part in any computations
    signal input fee;       // not taking part in any computations
    signal input refund;    // not taking part in any computations

    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component hasher = CommitmentHasher();
    hasher.nullifier <== nullifier;
    hasher.secret <== secret;
    hasher.nullifierHash === nullifierHash;

    component tree = MerkleTreeChecker(levels);
    tree.leaf <== hasher.commitment;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // Bind recipient/relayer/fee/refund into the proof so a relayer cannot
    // redirect the payout. Squares are used because the optimiser would
    // otherwise drop constraints on signals that feed nothing.
    //
    // Dropping these four lines is THE classic fatal bug in Tornado forks:
    // the proof still verifies, but any relayer can rewrite the recipient to
    // its own address and steal every withdrawal that passes through it.
    signal recipientSquare;
    signal feeSquare;
    signal relayerSquare;
    signal refundSquare;
    recipientSquare <== recipient * recipient;
    feeSquare <== fee * fee;
    relayerSquare <== relayer * relayer;
    refundSquare <== refund * refund;
}

component main {public [root, nullifierHash, recipient, relayer, fee, refund]}
    = Withdraw(20);
