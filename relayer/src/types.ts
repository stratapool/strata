import { z } from 'zod';

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 32-byte hex');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address');
const uint = z.string().regex(/^(0x[0-9a-fA-F]+|\d+)$/, 'expected a uint');

export const withdrawRequestSchema = z.object({
  proof: z.object({
    a: z.tuple([uint, uint]),
    b: z.tuple([z.tuple([uint, uint]), z.tuple([uint, uint])]),
    c: z.tuple([uint, uint]),
  }),
  root: hex32,
  nullifierHash: hex32,
  recipient: address,
  /**
   * Which relayer the proof pays. The client sets this when building the
   * proof; we refuse anything that does not name us, because submitting it
   * would spend our gas to pay a competitor.
   */
  relayer: address,
});

export type WithdrawRequest = z.infer<typeof withdrawRequestSchema>;

export interface RelayResult {
  txHash: string;
  relayerFee: string;
  gasUsed: string;
}
