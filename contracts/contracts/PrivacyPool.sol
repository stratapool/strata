// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MerkleTreeWithHistory.sol";

interface IVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[6] calldata input
    ) external view returns (bool);
}

/// @title Strata — fixed-denomination privacy pool
/// @notice Deposit a fixed amount, withdraw later to an unrelated address by
///         proving in zero knowledge that you own one of the pool's notes,
///         without revealing which.
/// @dev No owner. No upgrade path. No pause. Nothing about this contract can
///      be changed after deployment, including the fee split and the cap
///      schedule. That is the point: there is no key to steal or subpoena.
contract PrivacyPool is MerkleTreeWithHistory {
    // ---------------------------------------------------------------- fees --
    /// @dev Total 0.3%, split 0.2% relayer / 0.1% reserve. Constants, not
    ///      parameters: if the fee could vary per withdrawal, the payout
    ///      amount would differ between users and become a fingerprint,
    ///      which defeats the entire point of a fixed denomination.
    uint256 public constant FEE_BPS = 30;
    uint256 public constant RELAYER_BPS = 20;
    uint256 public constant RESERVE_BPS = 10;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ------------------------------------------------------------ no cap --
    /// @dev Deliberately uncapped.
    ///
    ///      An earlier revision bounded the pool's balance so that a circuit
    ///      bug could only ever drain a fixed amount. That was dropped on
    ///      purpose: on a new chain the anonymity set is the moat and it is
    ///      won by whoever gets there first, so throttling intake throttles
    ///      the only thing that makes this product work.
    ///
    ///      The consequence is that a circuit bug drains everything, with no
    ///      pause and no upgrade to stop it. Nothing in this contract limits
    ///      that, so the disclosure in the interface is the only protection
    ///      users have and must stay prominent.

    IVerifier public immutable verifier;
    uint256 public immutable denomination;
    /// @notice When this pool opened. Informational — the interface uses it to
    ///         show how long the set has had to build.
    uint256 public immutable deployedAt;

    /// @notice Accrued 0.1%. There is no function anywhere that pays this out.
    /// @dev Tracked separately from note principal so the invariant
    ///      `balance >= unspentNotes * denomination` can be checked. In this
    ///      version the reserve is permanently locked; see the note on
    ///      `MINING_CLAIM` in docs/design/privacy-pool.md §5.3.
    uint256 public reserve;

    mapping(bytes32 => bool) public commitments;
    mapping(bytes32 => bool) public nullifierHashes;

    /// @notice Notes deposited but not yet withdrawn. This — not the balance —
    ///         is the anonymity set.
    uint256 public unspentNotes;

    event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp);
    event Withdrawal(
        address indexed to,
        bytes32 nullifierHash,
        address indexed relayer,
        uint256 relayerFee
    );

    constructor(
        IVerifier _verifier,
        IHasher _hasher,
        uint256 _denomination,
        uint32 _levels
    ) MerkleTreeWithHistory(_levels, _hasher) {
        require(_denomination > 0, "denomination must be > 0");
        // Below roughly 0.1 ETH on this chain the relayer's 0.2% no longer
        // covers withdrawal gas, so nobody would relay and users could not
        // withdraw to an unfunded address — which is the whole product.
        require(_denomination >= 0.01 ether, "denomination too small to relay");
        verifier = _verifier;
        denomination = _denomination;
        deployedAt = block.timestamp;
    }

    /// @notice Deposit one note. `_commitment` = Pedersen(nullifier, secret),
    ///         computed client-side; this contract never sees either secret.
    function deposit(bytes32 _commitment) external payable {
        require(msg.value == denomination, "wrong denomination");
        // Rejecting duplicates stops a griefer from front-running a deposit
        // with the same commitment: only one of the two could ever be spent,
        // and the other's funds would be stranded forever.
        require(!commitments[_commitment], "commitment already used");

        commitments[_commitment] = true;
        unspentNotes += 1;
        uint32 index = _insert(_commitment);
        emit Deposit(_commitment, index, block.timestamp);
    }

    /// @notice Spend a note. Anyone may call this; the proof, not the caller,
    ///         is the authorisation.
    /// @dev Callable directly, without the relayer or the official frontend.
    ///      If either is censored or disappears, users can still get their
    ///      money out — at the cost of paying gas from a funded address.
    /// @param _proofA,_proofB,_proofC Groth16 proof.
    /// @param _root A recent merkle root published by this contract.
    /// @param _nullifierHash Pedersen(nullifier). Burned here, forever.
    /// @param _recipient Where the funds go. Bound inside the proof.
    /// @param _relayer Who receives the 0.2%. Bound inside the proof.
    function withdraw(
        uint256[2] calldata _proofA,
        uint256[2][2] calldata _proofB,
        uint256[2] calldata _proofC,
        bytes32 _root,
        bytes32 _nullifierHash,
        address payable _recipient,
        address payable _relayer
    ) external {
        require(!nullifierHashes[_nullifierHash], "note already spent");
        require(isKnownRoot(_root), "unknown merkle root");
        require(_recipient != address(0), "recipient is zero");

        // The circuit's public signals, in template declaration order.
        // `fee` and `refund` are always zero: this protocol fixes the fee as
        // a constant below, so the circuit's variable-fee slots go unused.
        // They remain in the circuit only because removing them would have
        // meant editing it. See docs/design/privacy-pool.md §3.2.
        uint256[6] memory input = [
            uint256(_root),
            uint256(_nullifierHash),
            uint256(uint160(address(_recipient))),
            uint256(uint160(address(_relayer))),
            uint256(0), // fee
            uint256(0) // refund
        ];
        require(
            verifier.verifyProof(_proofA, _proofB, _proofC, input),
            "invalid proof"
        );

        // Effects before interactions.
        nullifierHashes[_nullifierHash] = true;
        unspentNotes -= 1;

        uint256 relayerFee = (denomination * RELAYER_BPS) / BPS_DENOMINATOR;
        uint256 reserveFee = (denomination * RESERVE_BPS) / BPS_DENOMINATOR;

        // A self-submitted withdrawal names no relayer. Rather than hand the
        // caller a discount — which would make self-withdrawals a distinct,
        // identifiable amount and leak which withdrawals were self-submitted —
        // the relayer share goes to the reserve. Every withdrawal of a given
        // denomination therefore pays out exactly the same number.
        if (_relayer == address(0)) {
            reserveFee += relayerFee;
            relayerFee = 0;
        }

        reserve += reserveFee;
        uint256 payout = denomination - relayerFee - reserveFee;

        _send(_recipient, payout);
        if (relayerFee > 0) _send(_relayer, relayerFee);

        emit Withdrawal(_recipient, _nullifierHash, _relayer, relayerFee);
    }

    /// @dev `call` rather than `transfer`: the 2300-gas stipend is not enough
    ///      for a contract recipient, and a fresh privacy-preserving address
    ///      may well be a smart account.
    function _send(address payable _to, uint256 _amount) private {
        (bool ok, ) = _to.call{value: _amount}("");
        require(ok, "transfer failed");
    }

    /// @notice Value backing unspent notes. Must always be covered by balance.
    function notePrincipal() public view returns (uint256) {
        return unspentNotes * denomination;
    }

    /// @notice Sanity invariant, exposed for monitoring and tests.
    /// @dev If this ever returns false the pool is insolvent and some holder
    ///      will not be able to withdraw.
    function isSolvent() public view returns (bool) {
        return address(this).balance >= notePrincipal() + reserve;
    }

    function isSpent(bytes32 _nullifierHash) external view returns (bool) {
        return nullifierHashes[_nullifierHash];
    }
}
