import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8788),
  HOST: z.string().default('127.0.0.1'),

  RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: z.coerce.number().int().positive().default(4663),
  POOL_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

  /** Path to the circuit's verification_key.json. */
  VERIFICATION_KEY: z.string().default('../circuits/build/verification_key.json'),

  /**
   * Hot wallet. A keystore is strongly preferred; the raw-key path exists for
   * local development and is refused when NODE_ENV=production.
   */
  KEYSTORE_PATH: z.string().optional(),
  KEYSTORE_PASSWORD: z.string().optional(),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),

  /**
   * Refuse to relay when gas would eat more than this fraction of the fee.
   *
   * At 0.1 ETH denomination the relayer earns 0.0002 ETH against roughly
   * 0.00002 ETH of gas — a 10x margin, so 0.5 leaves plenty of room. Orbit
   * chains have congestion pricing and a spike can invert that; without this
   * the relayer quietly subsidises every withdrawal until the wallet empties.
   *
   * Compared against the *expected* cost — baseFee + tip — not the ceiling the
   * node quotes. Values above 1 mean the relayer accepts a bounded loss to stay
   * available; below 1 it stops relaying before it stops profiting.
   *
   * 1.2 is the default because the margin at the 0.01 minimum denomination is
   * real but thin: the 0.2% fee is 0.00002 ETH against roughly 0.0000173 of
   * gas, so a ratio of exactly 1.0 leaves about 5% of slack and gas moves more
   * than that. The alternative to a small bounded loss is a relayer that
   * intermittently refuses, and a user who cannot withdraw through it has to
   * self-submit from a funded address — which costs them the privacy of that
   * withdrawal. That trade is worth a few wei.
   */
  MAX_GAS_FEE_RATIO: z.coerce.number().positive().max(20).default(1.2),

  /** Warn loudly below this balance; the float is meant to be self-sustaining. */
  MIN_BALANCE_ETH: z.coerce.number().nonnegative().default(0.002),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);

  const hasKeystore = Boolean(parsed.KEYSTORE_PATH && parsed.KEYSTORE_PASSWORD);
  const hasRawKey = Boolean(parsed.RELAYER_PRIVATE_KEY);

  if (!hasKeystore && !hasRawKey) {
    throw new Error(
      'no hot wallet configured: set KEYSTORE_PATH + KEYSTORE_PASSWORD, or RELAYER_PRIVATE_KEY for local dev',
    );
  }
  if (parsed.NODE_ENV === 'production' && !hasKeystore) {
    throw new Error(
      'production requires an encrypted keystore; a plaintext RELAYER_PRIVATE_KEY is not accepted',
    );
  }
  return parsed;
}
