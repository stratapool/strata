import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8789),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** Where the working zkey, the transcript and uploads live. */
  DATA_DIR: z.string().default('./data'),
  /** Circuit artefacts. Read-only; the ceremony never regenerates them. */
  R1CS_PATH: z.string(),
  PTAU_PATH: z.string(),

  /**
   * How long a contributor holds the chain before the slot is reclaimed.
   *
   * Bounded by the slowest realistic round trip, not by the compute: the
   * contribution itself takes about two seconds, but it is bracketed by a 20 MB
   * download and a 20 MB upload, and someone on a phone tethered to bad
   * signal needs room for both. Too short and honest contributors lose the
   * work they just did; too long and one abandoned tab stalls everyone.
   */
  SLOT_TTL_SECONDS: z.coerce.number().int().positive().default(1_200),

  /**
   * The Drand round whose randomness finalises the ceremony.
   *
   * Announced when the ceremony opens, not chosen at the end. A beacon picked
   * afterwards still has to be trusted — nobody can tell whether it was the
   * first value drawn or the thousandth. A round number published in advance
   * cannot be reconsidered: the value does not exist yet, and when it does,
   * anyone can fetch it from the drand network and check it independently.
   *
   * It does not replace an honest contributor. It removes the last thing the
   * operator would otherwise have to be trusted about.
   */
  DRAND_ROUND: z.coerce.number().int().positive().optional(),
  DRAND_URL: z.string().default('https://api.drand.sh'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
