import { describe, expect, it, beforeEach, vi } from 'vitest';

// The suite runs in node, and this module persists a fingerprint. A map is
// enough — the point under test is the derivation, not the storage.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
});
const dumpStorage = () => JSON.stringify([...store.entries()]);
import { deriveSeed } from './keys';
import { seedFromSignature } from '@strata/shared/keys';

/**
 * A wallet whose signature is not reproducible loses every note derived from
 * it, and does so without an error anywhere: the next unlock derives a
 * different seed, the scan matches nothing, and the balance reads zero exactly
 * as it would for a wallet that never deposited. These tests exist because
 * that failure is indistinguishable from normal operation.
 */
const SIG_A = '0x' + '11'.repeat(65);
const SIG_B = '0x' + '22'.repeat(65);
const ACCOUNT = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

function walletSigning(signatures: string[]) {
  let i = 0;
  const signMessage = vi.fn(async () => signatures[Math.min(i++, signatures.length - 1)]!);
  return {
    provider: {} as never,
    signMessage,
    calls: () => signMessage.mock.calls.length,
  };
}

// BrowserProvider is the only thing standing between us and a real wallet.
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    BrowserProvider: class {
      constructor(public p: unknown) {}
      async getSigner() {
        return { signMessage: (globalThis as never as { __sign: () => Promise<string> }).__sign };
      }
    },
  };
});

const useWallet = (sigs: string[]) => {
  const w = walletSigning(sigs);
  (globalThis as never as { __sign: unknown }).__sign = w.signMessage;
  return w;
};

describe('deriveSeed', () => {
  beforeEach(() => localStorage.clear());

  it('accepts a wallet that signs the same message identically', async () => {
    const w = useWallet([SIG_A, SIG_A]);
    const seed = await deriveSeed({} as never, ACCOUNT);
    expect(seed).toBe(seedFromSignature(SIG_A));
    // Signed twice on first use: the check is the point.
    expect(w.calls()).toBe(2);
  });

  it('refuses a wallet whose signature changes, before anything is deposited', async () => {
    useWallet([SIG_A, SIG_B]);
    await expect(deriveSeed({} as never, ACCOUNT)).rejects.toThrow(
      /signs the same message differently/i,
    );
  });

  it('costs only one signature once the wallet is known', async () => {
    const first = useWallet([SIG_A, SIG_A]);
    await deriveSeed({} as never, ACCOUNT);
    expect(first.calls()).toBe(2);

    const second = useWallet([SIG_A]);
    await deriveSeed({} as never, ACCOUNT);
    expect(second.calls()).toBe(1);
  });

  it('catches a wallet that starts signing differently later', async () => {
    useWallet([SIG_A, SIG_A]);
    await deriveSeed({} as never, ACCOUNT);

    useWallet([SIG_B]);
    await expect(deriveSeed({} as never, ACCOUNT)).rejects.toThrow(
      /different signature than it did before/i,
    );
  });

  it('stores no seed and no address in the clear', async () => {
    useWallet([SIG_A, SIG_A]);
    const seed = await deriveSeed({} as never, ACCOUNT);
    const dump = dumpStorage();
    expect(dump).not.toContain(seed);
    expect(dump.toLowerCase()).not.toContain(ACCOUNT.toLowerCase());
  });

  it('does not confuse two wallets', async () => {
    const other = '0x1111111111111111111111111111111111111111';
    useWallet([SIG_A, SIG_A]);
    await deriveSeed({} as never, ACCOUNT);
    // A different account signing differently is not a divergence.
    useWallet([SIG_B, SIG_B]);
    await expect(deriveSeed({} as never, other)).resolves.toBe(seedFromSignature(SIG_B));
  });
});
