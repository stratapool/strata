import { readFile } from 'node:fs/promises';
import { JsonRpcProvider, Wallet } from 'ethers';
import type { Config } from './config.js';

/**
 * Loads the hot wallet.
 *
 * This wallet is permanently online and holds real funds, so the float is
 * meant to stay small — the 0.2% fee flows back to the same address, which
 * makes it self-sustaining after the first handful of withdrawals. Sweep
 * profit out periodically, but be careful where to: sweeping to an address
 * tied to your identity links the relayer to you, and the relayer address is
 * already public in every withdrawal it handles.
 */
export async function loadWallet(
  cfg: Config,
  provider: JsonRpcProvider,
): Promise<Wallet> {
  if (cfg.KEYSTORE_PATH && cfg.KEYSTORE_PASSWORD) {
    const json = await readFile(cfg.KEYSTORE_PATH, 'utf8');
    const wallet = await Wallet.fromEncryptedJson(json, cfg.KEYSTORE_PASSWORD);
    return wallet.connect(provider) as Wallet;
  }
  // config.ts already refuses this path when NODE_ENV=production.
  return new Wallet(cfg.RELAYER_PRIVATE_KEY!, provider);
}
