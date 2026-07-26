# Strata

A fixed-denomination privacy pool on Robinhood Chain.

Deposit a fixed amount, wait, then withdraw to an address that has never been
linked to you. A zero-knowledge proof shows you own one of the pool's notes
without revealing which one.

**[stratapool.xyz](https://stratapool.xyz)** · [@starccai](https://x.com/starccai)

---

## What review this code has had

**No third-party audit.** What has been done instead:

- The circuit is **Tornado Cash v1's, unchanged** — the most-audited ZK circuit
  in production, reviewed multiple times over several years. The only edits are
  the circom 1 → 2 syntax migration. Hashes below let you check that claim.
- **circomspect** (Trail of Bits' static analyser) reports no errors. Its three
  warnings are about `recipientSquare` / `feeSquare` / `relayerSquare` each
  appearing in a single constraint — which is deliberate; those signals exist
  only to bind the public inputs into the proof.
- **13 tests** covering deposit, proof generation, on-chain verification,
  double-spend rejection, and the recipient-tampering attack that a missing
  constraint would enable.
- An end-to-end run against the live pool: five deposits, five withdrawals to
  fresh addresses, one rejected double-spend. See `scripts/e2e-live.mjs`.

None of that is an audit. A linter cannot tell you whether a circuit computes
the right thing, and the people who wrote the code are the worst people to
review it. Treat the above as the floor, not the ceiling.

The contracts also cannot be paused or upgraded, there is no cap on what the
pool can hold, and no owner who could intervene. If the circuit is wrong, an
attacker can forge proofs and take everything — and a forged proof is
indistinguishable on-chain from a real one.

**The phase-2 trusted setup has not yet been run publicly.** Groth16's
parameters derive from a secret that must be destroyed; whoever can reconstruct
it can forge proofs and empty the pool, and a forged proof is indistinguishable
on-chain from a real one. Phase 1 comes from the Perpetual Powers of Tau, where
thousands of participants mean only one had to be honest. Phase 2 was run here
by a single party.

The contribution's entropy comes from `crypto.randomBytes(32)`. An earlier
revision used `Date.now() + Math.random()` — a recoverable timestamp and a
non-CSPRNG — and the first deployment shipped with a key generated that way.
That key is gone; the pool below was deployed against a freshly generated one.
Good entropy does not fix the underlying problem, though: a single-party phase 2
rests entirely on that party having destroyed its secret, and nobody else can
verify that. Any pool meant to hold other people's money needs a public,
multi-party ceremony and a redeployment against its output.

Until then, treat this as a demonstration.

This is stated in the interface as well. It is not going to be softened.

---

## Deployment

Robinhood Chain, chain ID **4663**.

| Contract | Address |
| --- | --- |
| `PrivacyPool` | [`0x40aF9DE1EE5125772e4E3192fAf53B57f4d5A249`](https://stratapool.xyz) |
| `Groth16Verifier` | `0xeDD96Fb3EA3451d653eb1ebaD350566A8f17DDe7` |
| MiMC hasher | `0x4aEE710cc6d536f2064BD1Ca194B5BB0d54Ff97f` |

Denomination **0.1 ETH**, merkle depth 20, deployed at block 19945005.

Withdrawal fee is **0.3%**, split in the contract and unchangeable:

- **0.2%** to the relayer that fronts your gas. Without a relayer you would
  have to fund your fresh withdrawal address first, and that transfer would
  link it to you permanently. We run the default relayer, so this share
  currently goes to us; the contract lets anyone run one and the proof names
  whichever relayer you choose.
- **0.1%** into a pool reserve. There is no function anywhere that pays it out.

## Verifying the deployment

The proving key is ~20 MB and is not in this repository. It is also **not
reproducible** — the phase-2 contribution used randomness, so re-running
`circuits/scripts/setup.mjs` produces a different key. The deployed verifier
was generated from this exact file:

```
withdraw_final.zkey        27fe02b1f69c167e2a21bc61f2b0dd9ce023e95e4d92ff0961112cbac7e40de6
withdraw.wasm              df9bbcca32063c04f82c571238f4e9e6ef447674f1e4a4eb968b7e4c455af968
verification_key.json      2c719c1a35b8fb235c2192602a693175dfed659121c5a25cbf6045a1f769f007
Verifier.sol               a33664b676ce5dc3316b44afd95f2a81e5e666e8e507912b321057535673b0d2
circuits/withdraw.circom   b6f4e710c1b0ef65e72ef09986b8060922d0cbf532da82e344e0a597450ed514
circuits/merkleTree.circom 1c2034409a2cc06f37d2b9286391bdc1ca7baef3a9d4cb154b4f9f0f8d59af47
```

Download the proving key from the site and check it against the hash above —
that way you do not have to trust the host it came from:

```bash
curl -sO https://stratapool.xyz/circuit/withdraw_final.27fe02b1.zkey
sha256sum withdraw_final.27fe02b1.zkey
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
