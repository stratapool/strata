# Strata

A fixed-denomination privacy pool on Robinhood Chain.

Deposit a fixed amount, wait, then withdraw to an address that has never been
linked to you. A zero-knowledge proof shows you own one of the pool's notes
without revealing which one.

**[stratapool.xyz](https://stratapool.xyz)** · [@starccai](https://x.com/starccai)

---

## What review this code has had

**No completed audit — one is being arranged.** Until it lands, this is what
review the code has actually had:

- The circuit is **Tornado Cash v1's, unchanged** — the most-audited ZK circuit
  in production, reviewed multiple times over several years. The only edits are
  the circom 1 → 2 syntax migration. Hashes below let you check that claim.
- **circomspect** (Trail of Bits' static analyser) reports no errors. Its three
  warnings are about `recipientSquare` / `feeSquare` / `relayerSquare` each
  appearing in a single constraint — which is deliberate; those signals exist
  only to bind the public inputs into the proof.
- **54 tests** across four packages: 22 on the contracts, covering deposit,
  proof generation, on-chain verification, double-spend rejection, the
  recipient-tampering attack a missing constraint would enable, and frozen
  vectors for note-key derivation; 20 in the client; 6 on the relayer; 6 on the
  ceremony coordinator, where the case that matters is an upload that would
  erase a contributor.
- **Four independent adversarial audits**, one per subsystem, told not to
  believe the comments. They found a cross-pool proof replay, a client that
  disclosed its own note set to the RPC provider, a way for one contributor to
  wedge the ceremony permanently, and three comments asserting properties the
  code did not have. All fixed; the comments are corrected in place.
- An end-to-end run against the live pool: deposits, withdrawals to fresh
  addresses, a rejected double-spend. See `scripts/e2e-live.mjs`.
- The browser client exercised against the deployed pool — scanning, note
  export and import, and Groth16 proving in the page, checked against the
  published verification key.

None of that is an audit. A linter cannot tell you whether a circuit computes
the right thing, and the people who wrote the code are the worst people to
review it. Treat the above as the floor, not the ceiling.

The contracts also cannot be paused or upgraded, there is no cap on what the
pool can hold, and no owner who could intervene. If the circuit is wrong, an
attacker can forge proofs and take everything — and a forged proof is
indistinguishable on-chain from a real one.

**The phase-2 ceremony is complete.** Groth16's parameters derive from a secret
that must be destroyed; whoever can reconstruct it can forge proofs and empty
the pool, and a forged proof is indistinguishable on-chain from a real one.
Phase 1 comes from the Perpetual Powers of Tau, where thousands of participants
mean only one had to be honest. Phase 2 is now the same shape, at a much
smaller scale: **six contributions**, each generating randomness in the
contributor's own browser and discarding it, closed with a publicly verifiable
beacon.

**So long as any one of those six destroyed their randomness, nobody can forge
a proof — including us.** That is the whole of the guarantee, and it replaces
the previous one, which was that we said so.

Two things it does not establish, and nobody should read into it:

- **Contributions are anonymous.** Six entries mean six independent parties
  only if they were six different people, and nothing on the ceremony page or
  in the transcript proves that. Anyone able to run six browsers could have
  produced all of them, in which case the guarantee is worth what one
  contribution is worth.
- **Verification is not contribution.** Two verifiers independently confirmed
  the chain is intact. That establishes the transcript has not been tampered
  with and says nothing whatever about whether anyone destroyed a secret.

The closing beacon is drand round **6324172**, announced before its value
existed so it could not be selected for. The window was shortened from a
previously announced round once contributions were judged sufficient; both
rounds were in the future when named, which is the only property that matters,
but the change is recorded here rather than left for someone to notice.

Reproduce the deployed key yourself — the ceremony still serves the contributed
key it closed on:

```bash
curl -so contributed.zkey https://stratapool.xyz/ceremony/zkey
sha256sum contributed.zkey            # 5e3ae46747228c39dd3e8221a41c78bedf8eb17e7966f60d63a7ec0bbe669524

curl -s https://api.drand.sh/public/6324172   # randomness a0e170779fea...
snarkjs zkey beacon contributed.zkey final.zkey   drand-6324172   a0e170779fea33571e3bf27ed13b118581604948f04eb1bdc0a9eacf0cbb5b42 10
sha256sum final.zkey                  # must match the manifest below
```

The full transcript, including every contribution hash, is at
[stratapool.xyz/ceremony](https://stratapool.xyz/#/ceremony) and served as JSON
from `/ceremony/transcript`.

This is stated in the interface as well. It is not going to be softened.

---

## Deployment

Robinhood Chain, chain ID **4663**.

| Contract | Address |
| --- | --- |
| `PrivacyPool` | [`0x4daA62B28c4529479785892443E0a0DFe392f460`](https://stratapool.xyz) |
| `Groth16Verifier` | `0x57254c611587343958EAbB70993b85Bc7948524F` |
| MiMC hasher | `0x4aEE710cc6d536f2064BD1Ca194B5BB0d54Ff97f` |

Denomination **0.01 ETH**, merkle depth 20, deployed at block 20742508 —
against the ceremony's output, replacing an earlier deployment that ran on a
single-party key.

The denomination is a constructor argument and cannot be changed — the
commitment is `Pedersen(nullifier, secret)` and carries no amount, so a pool
that could change its denomination would pay out whatever the current value is
regardless of what was deposited. Other sizes are separate contracts. The
verifier and hasher above are shared with them: both are functions of the
circuit, not of the denomination.

Withdrawal fee is **0.3%**, split in the contract and unchangeable:

- **0.2%** to the relayer that fronts your gas. Without a relayer you would
  have to fund your fresh withdrawal address first, and that transfer would
  link it to you permanently. We run the default relayer, so this share
  currently goes to us; the contract lets anyone run one and the proof names
  whichever relayer you choose.
- **0.1%** into a pool reserve. There is no function anywhere that pays it out.

## Verifying the deployment

The proving key is ~20 MB and is not in this repository. It **is** reproducible
now, which it was not before: the ceremony's contributed key plus the announced
drand beacon give exactly the file below, and the commands for that are in the
trusted-setup section above. The deployed verifier was generated from it:

```
withdraw_final.zkey        f2239587640574f7910630d2d4fb817a1b42e6d0b1afc674c688aab43858f753
withdraw.wasm              df9bbcca32063c04f82c571238f4e9e6ef447674f1e4a4eb968b7e4c455af968
verification_key.json      ccbbc843203c22552b3ac0ea2477c7b807124fc67b44a8c412e8cffc461d8d5e
Verifier.sol               790008aa741353707a65cd32f2f02e11a259abd0f6878473abd07cea0efa7313
circuits/withdraw.circom   b6f4e710c1b0ef65e72ef09986b8060922d0cbf532da82e344e0a597450ed514
circuits/merkleTree.circom 1c2034409a2cc06f37d2b9286391bdc1ca7baef3a9d4cb154b4f9f0f8d59af47
```

Download the proving key from the site and check it against the hash above —
that way you do not have to trust the host it came from:

```bash
curl -sO https://stratapool.xyz/circuit/withdraw_final.f2239587.zkey
sha256sum withdraw_final.f2239587.zkey
```

The verification key is served too, so a proof can be checked without trusting
anything here:

```bash
curl -sO https://stratapool.xyz/circuit/verification_key.json
sha256sum verification_key.json
```

The filename carries the first 8 hex of that hash. It is served `immutable`
with a one-year lifetime, so the name has to change whenever the bytes do —
otherwise a returning visitor's browser keeps the retired key and every proof
it produces is rejected on chain.

## The circuit

`circuits/circuits/withdraw.circom` is **Tornado Cash v1's circuit, unchanged**.
The only edits are the circom 1 → 2 syntax migration.

It is deliberately not modernised. Poseidon would use fewer constraints than
the Pedersen and MiMC it uses, but this chain's gas is around 0.05 gwei so the
saving is worth approximately nothing — while touching the circuit would forfeit
the assurance inherited from the most-audited ZK code in existence. Without an
audit budget, edit count *is* risk exposure.

36,047 non-linear constraints, 6 public signals, 42 private.

`recipient` and `relayer` are bound into the proof with squared constraints. If
those four lines were dropped the proof would still verify and any relayer
could rewrite the payout address — it is the classic fatal bug in Tornado
forks, and there is a test for it.

## Layout

```
circuits/    withdraw circuit + trusted setup scripts
contracts/   PrivacyPool, MerkleTreeWithHistory, generated verifier
relayer/     fronts gas for withdrawals; verifies proofs off-chain first
shared/      note construction, merkle tree, proof encoding — one copy, used
             by contracts, relayer and web so they cannot drift apart
web/         React interface; proves in the browser, secrets never leave it
```

## Running it

```bash
# circuit: compile and run a trusted setup
cd circuits && npm i && npm run build && npm run setup

# contracts: 13 tests, deposit → proof → on-chain withdraw
cd contracts && npm i && npx hardhat test

# relayer
cd relayer && npm i && cp .env.example .env && npm run dev

# web (simulated pool without VITE_POOL_ADDRESS)
cd web && npm i && npm run dev
```

An end-to-end exercise against the live pool, no browser involved:

```bash
cd contracts
DEPLOYER_KEY=0x... node scripts/e2e-live.mjs --wallets 5
```

It funds throwaway wallets, deposits, withdraws each note to a fresh address
through the relayer, attempts a double-spend, and then prints everything a
chain observer can see next to the mapping only the note holder knows — so the
unlinkability claim can be checked rather than taken on trust.

## What this does not give you

Cryptographic unlinkability is not the same as cover. The anonymity set is the
number of **unspent** notes at the same denomination — not the pool's balance,
and not the number of deposits ever made. With a handful of notes, timing alone
narrows a withdrawal to its deposit no matter how good the proof is.

That needs volume, not code. The interface shows the real figure and will tell
you to wait when it is too small.

## Licence

MIT. The circuit and merkle tree derive from
[tornado-core](https://github.com/tornadocash/tornado-core), also MIT.
