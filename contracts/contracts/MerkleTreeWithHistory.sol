// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MerkleTreeZeros.sol";

/// @dev circomlib's generated MiMC sponge. Note the third parameter: Tornado
///      was built against an older circomlib whose contract took only
///      (xL, xR). Current circomlibjs emits (xL, xR, k). Declaring the old
///      two-argument form compiles fine and then fails at runtime with an
///      invalid opcode, because the selector simply does not exist.
interface IHasher {
    function MiMCSponge(uint256 in_xL, uint256 in_xR, uint256 k)
        external
        pure
        returns (uint256 xL, uint256 xR);
}

/// @notice Append-only incremental Merkle tree with a rolling root history.
/// @dev This is Tornado Cash v1's MerkleTreeWithHistory, ported to Solidity
///      0.8 (checked arithmetic, immutables, custom errors left as strings).
///      The hashing and insertion logic is unchanged. See
///      docs/design/privacy-pool.md §3.2 for why nothing here was modernised.
contract MerkleTreeWithHistory is MerkleTreeZeros {
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @dev Tornado used 30. A browser generating a 36k-constraint Groth16
    ///      proof can take tens of seconds, and every deposit in that window
    ///      rotates the root; too small a history means honest users find
    ///      their freshly-built proof rejected. Larger costs only storage —
    ///      an old root grants no capability a new one does not, because
    ///      double-spends are stopped by nullifiers, not by root freshness.
    uint32 public constant ROOT_HISTORY_SIZE = 120;

    IHasher public immutable hasher;
    uint32 public immutable levels;

    mapping(uint256 => bytes32) public filledSubtrees;
    mapping(uint256 => bytes32) public roots;

    uint32 public currentRootIndex;
    uint32 public nextIndex;

    constructor(uint32 _levels, IHasher _hasher) {
        require(_levels > 0, "levels must be > 0");
        require(_levels < 32, "levels must be < 32");
        levels = _levels;
        hasher = _hasher;

        for (uint32 i = 0; i < _levels; i++) {
            filledSubtrees[i] = zeros(i);
        }
        // zeros(_levels), not zeros(_levels - 1): a leaf sits at level 0 and
        // _insert hashes _levels times, so the root lives at level _levels.
        // The off-by-one is harmless in isolation — no proof can ever match a
        // root of the empty tree — but it leaves the contract publishing a
        // root the client never computes, which makes it impossible to check
        // the two implementations against each other at deploy time. Agreeing
        // from block zero is worth more than the unreachable value.
        roots[0] = zeros(_levels);
    }

    /// @dev MiMC sponge over two field elements, matching the circuit's
    ///      HashLeftRight exactly. Any divergence here silently produces a
    ///      tree the circuit cannot prove against.
    function hashLeftRight(IHasher _hasher, bytes32 _left, bytes32 _right)
        public
        pure
        returns (bytes32)
    {
        require(uint256(_left) < FIELD_SIZE, "_left outside field");
        require(uint256(_right) < FIELD_SIZE, "_right outside field");
        uint256 R = uint256(_left);
        uint256 C = 0;
        (R, C) = _hasher.MiMCSponge(R, C, 0);
        R = addmod(R, uint256(_right), FIELD_SIZE);
        (R, C) = _hasher.MiMCSponge(R, C, 0);
        return bytes32(R);
    }

    function _insert(bytes32 _leaf) internal returns (uint32 index) {
        uint32 _nextIndex = nextIndex;
        require(_nextIndex != uint32(2) ** levels, "merkle tree is full");

        uint32 currentIndex = _nextIndex;
        bytes32 currentLevelHash = _leaf;
        bytes32 left;
        bytes32 right;

        for (uint32 i = 0; i < levels; i++) {
            if (currentIndex % 2 == 0) {
                left = currentLevelHash;
                right = zeros(i);
                filledSubtrees[i] = currentLevelHash;
            } else {
                left = filledSubtrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hashLeftRight(hasher, left, right);
            currentIndex /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = currentLevelHash;
        nextIndex = _nextIndex + 1;
        return _nextIndex;
    }

    /// @notice Whether the root is one this contract published recently.
    function isKnownRoot(bytes32 _root) public view returns (bool) {
        if (_root == 0) return false;
        uint32 _currentRootIndex = currentRootIndex;
        uint32 i = _currentRootIndex;
        do {
            if (_root == roots[i]) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE;
            i--;
        } while (i != _currentRootIndex);
        return false;
    }

    function getLastRoot() public view returns (bytes32) {
        return roots[currentRootIndex];
    }
}
