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

  async submit(req: WithdrawRequest, gasEstimate: bigint): Promise<RelayResult> {
    const tx = await this.contract.withdraw!(
      req.proof.a,
      req.proof.b,
      req.proof.c,
      req.root,
      req.nullifierHash,
      req.recipient,
      req.relayer,
      // Explicit limit so a mid-flight estimate change cannot strand the tx.
      { gasLimit: (gasEstimate * 130n) / 100n },
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new RelayRejected('withdrawal transaction reverted', 502);
    }
    return {
      txHash: receipt.hash,
      relayerFee: (await this.relayerFee()).toString(),
      gasUsed: receipt.gasUsed.toString(),
    };
  }
}
