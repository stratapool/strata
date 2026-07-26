# Strata

A fixed-denomination privacy pool on Robinhood Chain.

Deposit a fixed amount, wait, then withdraw to an address that has never been
linked to you. A zero-knowledge proof shows you own one of the pool's notes
without revealing which one.

**[stratapool.xyz](https://stratapool.xyz)** · [@starccai](https://x.com/starccai)

---

## Read this before depositing

**This code is unaudited.** The contracts cannot be paused or upgraded, there
is no cap on what the pool can hold, and no owner who could intervene. If the
circuit is wrong, an attacker can forge proofs and take everything, and a
forged proof is indistinguishable on-chain from a real one.

**The phase-2 trusted setup has not yet been run publicly.** Whoever holds the
toxic waste from the current ceremony could mint proofs out of nothing. Until a
public ceremony replaces it, treat the pool as a demonstration.

Both facts are stated in the interface as well. They are not going to be
softened.

---

## Deployment

Robinhood Chain, chain ID **4663**.

| Contract | Address |
| --- | --- |
| `PrivacyPool` | [`0x93e891eaD5cbDa33dd6074aC115E7D3b80FE0E33`](https://stratapool.xyz) |
| `Groth16Verifier` | `0x937cD504717d07E3B2653695330785C8aE5B6045` |
| MiMC hasher | `0xF176797B6D3Ce1B4C888EBa392b46cE900142b01` |

Denomination **0.01 ETH**, merkle depth 20, deployed at block 19868453.

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
withdraw_final.zkey        d2587049daa8a37668df27f86329f6a19eb2374f77e84ca28b4c1bb696b022d7
withdraw.wasm              df9bbcca32063c04f82c571238f4e9e6ef447674f1e4a4eb968b7e4c455af968
verification_key.json      a2f0e54f30c9f41dd7a25f4f1606d3a2bb5a37f9ae83dd366dfb4a2ef4133e8c
Verifier.sol               466a0dab2df04a0354b78501641ea55df633b1454de11a5b8c3c9cfc6021a648
circuits/withdraw.circom   b6f4e710c1b0ef65e72ef09986b8060922d0cbf532da82e344e0a597450ed514
circuits/merkleTree.circom 1c2034409a2cc06f37d2b9286391bdc1ca7baef3a9d4cb154b4f9f0f8d59af47
```

Download the proving key from the site and check it against the hash above —
that way you do not have to trust the host it came from:

```bash
curl -sO https://stratapool.xyz/circuit/withdraw_final.zkey
sha256sum withdraw_final.zkey
```

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
