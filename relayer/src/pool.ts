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
  async preflight(req: WithdrawRequest): Promise<{ gasEstimate: bigint; gasCost: bigint; fee: bigint }> {
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
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    // 20% headroom: the estimate is a floor, and Orbit congestion pricing can
    // move between estimate and inclusion.
    const gasCost = (gasEstimate * gasPrice * 120n) / 100n;

    const ceiling =
      (fee * BigInt(Math.round(this.cfg.MAX_GAS_FEE_RATIO * 10_000))) / 10_000n;
    if (gasCost > ceiling) {
      throw new RelayRejected(
        `gas ${formatEther(gasCost)} ETH exceeds ${this.cfg.MAX_GAS_FEE_RATIO * 100}% of the ${formatEther(fee)} ETH fee; relaying now would lose money`,
        503,
      );
    }

    const balance = await this.balance();
    if (balance < gasCost) {
      throw new RelayRejected('relayer hot wallet is out of gas', 503);
    }

    return { gasEstimate, gasCost, fee };
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
