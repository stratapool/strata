import { Contract, JsonRpcProvider, formatEther, type Wallet } from 'ethers';
import type { Config } from './config.js';
import type { RelayResult, WithdrawRequest } from './types.js';

export const POOL_ABI = [
  'function withdraw(uint256[2] _proofA, uint256[2][2] _proofB, uint256[2] _proofC, bytes32 _root, bytes32 _nullifierHash, address _recipient, address _relayer) external',
  'function isSpent(bytes32 _nullifierHash) external view returns (bool)',
  'function isKnownRoot(bytes32 _root) external view returns (bool)',
  'function getLastRoot() external view returns (bytes32)',
  'function denomination() external view returns (uint256)',
  'function RELAYER_BPS() external view returns (uint256)',
  'function unspentNotes() external view returns (uint256)',
  'function reserve() external view returns (uint256)',
  'function nextIndex() external view returns (uint32)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  // Needed by the log index. Undirected on purpose: it serves every burned
  // nullifier, never an answer about one the caller named.
  'event Withdrawal(address indexed to, bytes32 nullifierHash, address indexed relayer, uint256 relayerFee)',
];

export class RelayRejected extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'RelayRejected';
  }
}

export class PoolClient {
  readonly contract: Contract;
  #denomination: bigint | null = null;
  #relayerBps: bigint | null = null;

  constructor(
    private readonly cfg: Config,
    readonly provider: JsonRpcProvider,
    private readonly wallet: Wallet,
  ) {
    this.contract = new Contract(cfg.POOL_ADDRESS, POOL_ABI, wallet);
  }

  get address(): string {
    return this.wallet.address;
  }

  async denomination(): Promise<bigint> {
    this.#denomination ??= await this.contract.denomination!();
    return this.#denomination!;
  }

  async relayerFee(): Promise<bigint> {
    this.#relayerBps ??= await this.contract.RELAYER_BPS!();
    return ((await this.denomination()) * this.#relayerBps!) / 10_000n;
  }

  async balance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  /**
   * Everything that can be checked without spending gas, checked before we do.
   * Order matters: cheapest and most likely to fail first.
   */
  /**
   * Rejects a note that has already been burned.
   *
   * Called twice on purpose. preflight does it early so an obviously dead
   * request never reaches estimateGas; the queue does it again immediately
   * before submitting, because preflight runs concurrently and a burst of
   * duplicates would otherwise all clear it while the first was still in
   * flight. Only the second call is load-bearing — the first is politeness.
   */
  async assertUnspent(req: WithdrawRequest): Promise<void> {
    if (await this.contract.isSpent!(req.nullifierHash)) {
      throw new RelayRejected('note already spent');
    }
  }

  async preflight(
    req: WithdrawRequest,
  ): Promise<{ gasEstimate: bigint; expectedCost: bigint; worstCost: bigint; fee: bigint }> {
    if (req.relayer.toLowerCase() !== this.wallet.address.toLowerCase()) {
      throw new RelayRejected(
        'proof names a different relayer; submitting it would spend our gas to pay someone else',
      );
    }

    if (await this.contract.isSpent!(req.nullifierHash)) {
      throw new RelayRejected('note already spent');
    }

    // Roots rotate on every deposit. A proof built against a root that has
    // aged out of the history window will revert on-chain; catching it here
    // lets the client rebuild rather than lose a transaction.
    if (!(await this.contract.isKnownRoot!(req.root))) {
      throw new RelayRejected(
        'merkle root is unknown or has aged out of the history window; rebuild the proof',
      );
    }

    const fee = await this.relayerFee();

    let gasEstimate: bigint;
    try {
      gasEstimate = await this.contract.withdraw!.estimateGas(
        req.proof.a,
        req.proof.b,
        req.proof.c,
        req.root,
        req.nullifierHash,
        req.recipient,
        req.relayer,
      );
    } catch (e) {
      // The proof verified off-chain, so a revert here means state moved
      // under us (someone else spent the note, the root aged out) rather than
      // a bad proof.
      throw new RelayRejected(
        `simulation reverted: ${(e as Error).message.slice(0, 200)}`,
      );
    }

    const feeData = await this.provider.getFeeData();

    // "Will this pay for itself?" and "can the wallet cover it?" are different
    // questions and need different prices.
    //
    // An EIP-1559 transaction settles at baseFee + tip. maxFeePerGas is the
    // ceiling the node quotes — roughly baseFee * 2 — so that a spike between
    // signing and inclusion cannot strand it. Using that ceiling to decide
    // profitability, and then multiplying it by a further 1.2, overstated the
    // cost by about 2.4x: at a 0.01 denomination it refused every withdrawal
    // as loss-making while the real cost was 0.86 of the fee. The headroom was
    // also double-counting — a price that might rise is exactly what the
    // ceiling already models.
    const expectedPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    const worstPrice = feeData.maxFeePerGas ?? expectedPrice;

    // 10% on the estimate, not the price: estimateGas can undershoot when the
    // tree's insert path touches a different number of zero-to-nonzero slots.
    const expectedCost = (gasEstimate * expectedPrice * 110n) / 100n;
    const worstCost = gasEstimate * worstPrice;

    const ceiling =
      (fee * BigInt(Math.round(this.cfg.MAX_GAS_FEE_RATIO * 10_000))) / 10_000n;
    if (expectedCost > ceiling) {
      throw new RelayRejected(
        `gas ${formatEther(expectedCost)} ETH exceeds ${this.cfg.MAX_GAS_FEE_RATIO * 100}% of the ${formatEther(fee)} ETH fee; relaying now would lose money`,
        503,
      );
    }

    // Solvency is judged against the ceiling, because that is what the node may
    // actually deduct. A wallet that can only cover the expected price gets its
    // transaction stuck on the first spike.
    const balance = await this.balance();
    if (balance < worstCost) {
      throw new RelayRejected('relayer hot wallet is out of gas', 503);
    }

    return { gasEstimate, expectedCost, worstCost, fee };
  }

  /**
   * True once a transaction could not be resolved and the nonce is unaccounted
   * for. Nothing may be submitted after that: the next transaction would claim
   * a nonce that a still-pending one already holds, which is the collision the
   * serial queue exists to prevent. The server turns this into a fast, honest
   * refusal instead of a wait behind a wall.
   */
  get stuck(): boolean {
    return this.#stuck;
  }
  #stuck = false;

  async submit(req: WithdrawRequest, gasEstimate: bigint): Promise<RelayResult> {
    if (this.#stuck) {
      throw new RelayRejected(
        'relayer has an unresolved transaction and cannot submit; withdraw ' +
          'through another relayer or submit the proof yourself',
        503,
      );
    }

    const send = (overrides: Record<string, unknown>) =>
      this.contract.withdraw!(
        req.proof.a,
        req.proof.b,
        req.proof.c,
        req.root,
        req.nullifierHash,
        req.recipient,
        req.relayer,
        // Explicit limit so a mid-flight estimate change cannot strand the tx.
        { gasLimit: (gasEstimate * 130n) / 100n, ...overrides },
      );

    let tx = await send({});

    // `tx.wait()` with no timeout was the whole problem. A transaction that
    // never mines — underpriced against a spike, dropped by the mempool, or a
    // node that simply stops answering — left this await pending forever, and
    // because the queue is strictly serial every withdrawal behind it waited
    // just as long. Nobody was told anything.
    //
    // Bounding the wait alone would be worse than leaving it: releasing the
    // lane while a transaction is still pending means the next one claims the
    // same nonce. So a timeout is answered by *replacing* the transaction at
    // that same nonce with a higher-priced copy, which is the only move that
    // both frees the lane and keeps the nonce accounted for.
    //
    // Replacing a withdrawal with itself is safe: the two carry the same
    // nullifier, so whichever lands first burns the note and the other reverts
    // on "note already spent" without paying anyone twice.
    for (let bump = 0; ; bump++) {
      try {
        const receipt = await tx.wait(1, this.cfg.TX_TIMEOUT_MS);
        if (!receipt || receipt.status !== 1) {
          throw new RelayRejected('withdrawal transaction reverted', 502);
        }
        return {
          txHash: receipt.hash,
          relayerFee: (await this.relayerFee()).toString(),
          gasUsed: receipt.gasUsed.toString(),
        };
      } catch (e) {
        if (e instanceof RelayRejected) throw e;
        // Only a timeout is retryable here. Anything else already resolved the
        // nonce one way or the other.
        const timedOut = (e as { code?: string }).code === 'TIMEOUT';
        if (!timedOut) throw e;

        if (bump >= this.cfg.TX_MAX_BUMPS) {
          // Out of options with a transaction still in flight. Refusing new
          // work is the honest state: the alternative is guessing at a nonce
          // and silently dropping someone's withdrawal.
          this.#stuck = true;
          throw new RelayRejected(
            `transaction ${tx.hash} did not confirm after ${bump} fee bumps; ` +
              'the relayer is now refusing new withdrawals until it is resolved',
            504,
          );
        }

        // At least 12.5% or a replacement is rejected as underpriced; 30% to
        // clear it in one go rather than bumping repeatedly into the same wall.
        const bumped = (v: bigint | null | undefined) =>
          v == null ? undefined : (v * 130n) / 100n;
        const prev = await this.provider.getTransaction(tx.hash);
        tx = await send({
          nonce: tx.nonce,
          maxFeePerGas: bumped(prev?.maxFeePerGas ?? tx.maxFeePerGas),
          maxPriorityFeePerGas: bumped(
            prev?.maxPriorityFeePerGas ?? tx.maxPriorityFeePerGas,
          ),
        });
      }
    }
  }
}
