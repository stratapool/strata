import { useCallback, useEffect, useState } from 'react';
import type { Eip1193Provider } from 'ethers';
import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
} from '@reown/appkit/react';
import { deriveSeed } from './keys';

/**
 * No 'unavailable' state: AppKit offers WalletConnect, so there is always a
 * way to connect even with no injected wallet in the browser.
 */
export type WalletStatus =
  | 'disconnected'
  | 'wrong-chain'
  | 'connected'
  | 'unlocked';

export interface WalletState {
  status: WalletStatus;
  account: string | null;
  chainId: number | null;
  seed: string | null;
  error: string | null;
  busy: boolean;
}

/**
 * Wallet connection and note-key derivation, over Reown AppKit.
 *
 * Deliberately two steps. Connecting reveals an address; deriving the note
 * keys needs a second, explicit signature — and that signature is enough to
 * reconstruct the user's entire private balance. Keeping them apart means
 * someone can look at the pool without producing it.
 *
 * The seed is held in memory only. It is never written to storage, so closing
 * the tab forgets it and the user signs again — which is also why `lock()`
 * can drop it without disconnecting the wallet.
 */
export function useWallet(expectedChainId: number) {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const { chainId, switchNetwork } = useAppKitNetwork();
  const { walletProvider } = useAppKitProvider<Eip1193Provider>('eip155');

  const [seed, setSeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = address ?? null;
  const currentChain = chainId === undefined ? null : Number(chainId);

  // A changed account means different note keys. Holding the old seed would
  // display one wallet's balance under another's address.
  useEffect(() => {
    setSeed(null);
  }, [account]);

  const status: WalletStatus = !isConnected || !account
    ? 'disconnected'
    : currentChain !== null && currentChain !== expectedChainId
      ? 'wrong-chain'
      : seed
        ? 'unlocked'
        : 'connected';

  const connect = useCallback(async () => {
    setError(null);
    try {
      await open();
    } catch (e) {
      setError((e as Error).message ?? 'connection failed');
    }
  }, [open]);

  /** Second step: the signature that unlocks the private balance. */
  const unlock = useCallback(async () => {
    if (!walletProvider || !account) return;
    setBusy(true);
    setError(null);
    try {
      setSeed(await deriveSeed(walletProvider, account));
    } catch (e) {
      setError((e as Error).message ?? 'signature rejected');
    } finally {
      setBusy(false);
    }
  }, [walletProvider, account]);

  /** Drops the derived keys without disconnecting the wallet. */
  const lock = useCallback(() => setSeed(null), []);

  const switchChain = useCallback(async () => {
    setError(null);
    try {
      // AppKit's network object, not a raw hex chain id.
      const { robinhoodChain } = await import('../config/appkit');
      switchNetwork(robinhoodChain);
    } catch (e) {
      setError((e as Error).message ?? 'could not switch network');
    }
  }, [switchNetwork]);

  return {
    status,
    account,
    chainId: currentChain,
    seed,
    error,
    busy,
    provider: walletProvider ?? null,
    connect,
    unlock,
    lock,
    switchChain,
  };
}
