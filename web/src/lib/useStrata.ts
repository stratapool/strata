import { useEffect } from 'react';
import { ChainPool } from './chainPool';
import { chainConfig, usePool } from './usePool';
import { useWallet } from './useWallet';
import type { PoolClient, PoolState } from './types';

export interface Strata {
  pool: PoolClient;
  state: PoolState;
  balance: number;
  /** True when pointed at a deployed contract rather than the simulation. */
  live: boolean;
  wallet: ReturnType<typeof useWallet>;
  /** Whether deposits and withdrawals can actually be attempted right now. */
  ready: boolean;
  /** Non-null when the deployed pool could not be reached or read. */
  error: string | null;
}

const DEFAULT_CHAIN_ID = 4663;

/**
 * Joins the wallet to the pool.
 *
 * Against the simulation there is nothing to join and everything is "ready";
 * against a real deployment the user has to connect and then explicitly
 * derive their note keys before any balance exists to show.
 */
export function useStrata(): Strata {
  const cfg = chainConfig();
  const { pool, state, balance, live, error } = usePool();
  const wallet = useWallet(cfg?.chainId ?? DEFAULT_CHAIN_ID);

  useEffect(() => {
    if (pool instanceof ChainPool && wallet.provider && wallet.account) {
      void pool.connect(wallet.provider, wallet.account);
    }
  }, [pool, wallet.provider, wallet.account]);

  useEffect(() => {
    if (!(pool instanceof ChainPool) || !wallet.seed) return;
    pool.setSeed(wallet.seed);
    // Re-scan immediately: until the seed is known the client cannot tell
    // which on-chain commitments are the user's, so the balance reads zero.
    void pool.refresh();
  }, [pool, wallet.seed]);

  return {
    pool,
    state,
    balance,
    live,
    wallet,
    ready: !live || wallet.status === 'unlocked',
    error,
  };
}
