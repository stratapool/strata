import { describe, expect, it } from 'vitest';
import { PoolClient, RelayRejected } from '../src/pool.js';
import type { Config } from '../src/config.js';
import type { WithdrawRequest } from '../src/types.js';

/**
 * A withdrawal that never confirms used to hang `tx.wait()` forever, and the
 * serial queue meant every withdrawal behind it hung too. These cover the three
 * things that had to become true: the wait ends, the replacement reuses the
 * nonce, and a relayer that runs out of options says so instead of accepting
 * work it cannot do.
 */

const TIMEOUT = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });

const REQ = {
  proof: { a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n] },
  root: '0x' + '11'.repeat(32),
  nullifierHash: '0x' + '22'.repeat(32),
  recipient: '0x1111111111111111111111111111111111111111',
  relayer: '0x2222222222222222222222222222222222222222',
} as unknown as WithdrawRequest;

const cfg = {
  TX_TIMEOUT_MS: 20,
  TX_MAX_BUMPS: 2,
} as unknown as Config;

/**
 * @param confirmOnAttempt 1-based attempt that finally mines; Infinity never does.
 */
function makePool(confirmOnAttempt: number) {
  const sent: { nonce?: number; maxFeePerGas?: bigint }[] = [];
  let attempt = 0;

  const contract = {
    withdraw: (..._args: unknown[]) => {
      const overrides = _args[7] as { nonce?: number; maxFeePerGas?: bigint };
      attempt += 1;
      sent.push({ nonce: overrides.nonce, maxFeePerGas: overrides.maxFeePerGas });
      const mine = attempt >= confirmOnAttempt;
      return Promise.resolve({
        hash: `0xtx${attempt}`,
        nonce: 7,
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 100n,
        wait: () =>
          mine
            ? Promise.resolve({ hash: `0xtx${attempt}`, status: 1, gasUsed: 1n })
            : Promise.reject(TIMEOUT),
      });
    },
    RELAYER_BPS: () => Promise.resolve(20n),
    denomination: () => Promise.resolve(10n ** 16n),
  };

  // Built through the real constructor, not Object.create: #stuck is a private
  // field and only the constructor installs it, so a prototype-only stand-in
  // throws "cannot read private member" the moment the code under test reads
  // it — which is exactly the code under test.
  const provider = {
    getTransaction: () => Promise.resolve(null),
  } as unknown as ConstructorParameters<typeof PoolClient>[1];
  const wallet = {
    address: '0x2222222222222222222222222222222222222222',
  } as unknown as ConstructorParameters<typeof PoolClient>[2];

  const pool = new PoolClient(
    { ...cfg, POOL_ADDRESS: '0x' + '33'.repeat(20) } as Config,
    provider,
    wallet,
  );
  // The constructor builds a real Contract against a stub wallet; swap in the
  // scripted one. Same for relayerFee, so the test stays about nonce handling
  // rather than fee plumbing.
  Object.defineProperty(pool, 'contract', { value: contract, writable: true });
  Object.defineProperty(pool, 'relayerFee', { value: () => Promise.resolve(20n) });

  return { pool, sent };
}

describe('a withdrawal that does not confirm', () => {
  it('replaces it at the same nonce and succeeds', async () => {
    const { pool, sent } = makePool(2);
    const result = await pool.submit(REQ, 100_000n);

    expect(result.txHash).toBe('0xtx2');
    expect(sent).toHaveLength(2);
    // The first send lets ethers pick the nonce; the replacement must name the
    // one already in flight, or it is a second transaction rather than a
    // replacement and the queue's whole reason for existing is defeated.
    expect(sent[0]!.nonce).toBeUndefined();
    expect(sent[1]!.nonce).toBe(7);
    // Under a 12.5% bump the node rejects a replacement as underpriced.
    expect(sent[1]!.maxFeePerGas).toBe(1300n);
  });

  it('stops after the configured bumps and refuses further work', async () => {
    const { pool, sent } = makePool(Infinity);

    await expect(pool.submit(REQ, 100_000n)).rejects.toThrow(/did not confirm/);
    expect(sent).toHaveLength(cfg.TX_MAX_BUMPS + 1);

    // The nonce is now unaccounted for. Submitting anything else would claim
    // it a second time, so the relayer has to stop rather than guess.
    expect(pool.stuck).toBe(true);
    await expect(pool.submit(REQ, 100_000n)).rejects.toBeInstanceOf(RelayRejected);
    // Refused without sending — the count is unchanged from the failed run.
    expect(sent).toHaveLength(cfg.TX_MAX_BUMPS + 1);
  });

  it('does not mark itself stuck when the transaction simply reverts', async () => {
    const { pool } = makePool(1);
    (pool as unknown as { contract: { withdraw: unknown } }).contract.withdraw = () =>
      Promise.resolve({
        hash: '0xreverted',
        nonce: 7,
        wait: () => Promise.resolve({ hash: '0xreverted', status: 0, gasUsed: 1n }),
      });

    await expect(pool.submit(REQ, 100_000n)).rejects.toThrow(/reverted/);
    // A revert resolves the nonce. Refusing every later withdrawal over one
    // failed proof would be an outage manufactured from a normal outcome.
    expect(pool.stuck).toBe(false);
  });
});
