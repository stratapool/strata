import { useEffect, useMemo, useState } from 'react';
import { ChainPool, type ChainConfig } from './chainPool';
import { MockPool, resolveScenario } from './mockPool';
import type { PoolClient, PoolState } from './types';

/**
 * The single seam between the UI and the protocol.
 *
 * With VITE_POOL_ADDRESS set this talks to the deployed contract; without it,
 * to the simulated pool. Every component above this file is identical in both
 * cases — that was the point of defining PoolClient before writing any of
 * them, and it is why deploying does not mean rewriting the frontend.
 */
export function chainConfig(): ChainConfig | null {
  const address = import.meta.env.VITE_POOL_ADDRESS;
  if (!address) return null;
  return {
    rpcUrl: import.meta.env.VITE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
    chainId: Number(import.meta.env.VITE_CHAIN_ID ?? 4663),
    poolAddress: address,
    deployBlock: Number(import.meta.env.VITE_DEPLOY_BLOCK ?? 0),
    relayerUrl: import.meta.env.VITE_RELAYER_URL ?? '/relayer',
    proverAssets: {
      wasm: import.meta.env.VITE_CIRCUIT_WASM ?? '/circuit/withdraw.wasm',
      zkey: import.meta.env.VITE_CIRCUIT_ZKEY ?? '/circuit/withdraw_final.zkey',
    },
  };
}

export const isLive = (): boolean => chainConfig() !== null;

export function usePool(): {
  pool: PoolClient;
  state: PoolState;
  balance: number;
  live: boolean;
  /** Non-null when the client could not reach or read the deployed pool. */
  error: string | null;
} {
  const cfg = useMemo(chainConfig, []);
  const pool = useMemo<PoolClient>(
    () => (cfg ? new ChainPool(cfg) : new MockPool(resolveScenario(location.search))),
    [cfg],
  );
  const [state, setState] = useState<PoolState>(() => pool.getState());
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const unsub = pool.subscribe((s) => {
      setState(s);
      force((n) => n + 1);
    });
    if (pool instanceof ChainPool) {
      // A bad address, a dead RPC or a wrong chain id all land here. Surfacing
      // it beats an unhandled rejection and a page that silently shows zeros
      // as though the pool were simply empty.
      pool.start().catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    }
    return () => {
      unsub();
      if (pool instanceof ChainPool) pool.stop();
      else (pool as MockPool).stop();
    };
  }, [pool]);

  return { pool, state, balance: pool.getBalance(), live: cfg !== null, error };
}
