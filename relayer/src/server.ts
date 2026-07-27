import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { formatEther } from 'ethers';
import type { Config } from './config.js';
import { PoolClient, RelayRejected } from './pool.js';
import { SerialQueue } from './queue.js';
import type { ProofVerifier } from './verify.js';
import { withdrawRequestSchema } from './types.js';

export function createServer(
  cfg: Config,
  pool: PoolClient,
  verifier: ProofVerifier,
  queue: SerialQueue,
): Express {
  const app = express();
  // Behind Caddy. Without this every request carries the proxy's address, so
  // express-rate-limit keyed all clients into a single bucket: one caller could
  // spend the whole 20/min budget and deny withdrawals to everybody else. It is
  // exactly 1 because there is exactly one proxy in front — a larger number
  // would let a caller forge X-Forwarded-For and evade the limit entirely.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '64kb' }));

  // The relayer is the only part of this system that sees who is withdrawing
  // to where. It should log as little as possible and never persist it.
  app.disable('x-powered-by');

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const [balance, fee, notes] = await Promise.all([
        pool.balance(),
        pool.relayerFee(),
        pool.contract.unspentNotes!(),
      ]);
      const low = Number(formatEther(balance)) < cfg.MIN_BALANCE_ETH;
      res.json({
        ok: true,
        relayer: pool.address,
        pool: cfg.POOL_ADDRESS,
        chainId: cfg.CHAIN_ID,
        balanceEth: formatEther(balance),
        lowBalance: low,
        feePerWithdrawalEth: formatEther(fee),
        unspentNotes: notes.toString(),
        queueDepth: queue.depth,
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: (e as Error).message });
    }
  });

  /** Advertised so clients can bake the right relayer address into a proof. */
  app.get('/info', async (_req: Request, res: Response) => {
    res.json({
      relayer: pool.address,
      pool: cfg.POOL_ADDRESS,
      chainId: cfg.CHAIN_ID,
      denomination: (await pool.denomination()).toString(),
      relayerFee: (await pool.relayerFee()).toString(),
    });
  });

  app.post(
    '/relay',
    rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too many requests' },
    }),
    async (req: Request, res: Response) => {
      const parsed = withdrawRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'malformed request', detail: parsed.error.issues });
        return;
      }
      const request = parsed.data;

      try {
        // Verify before touching the chain. An unverified request must never
        // reach estimateGas, let alone a transaction.
        if (!(await verifier.verify(request))) {
          res.status(400).json({ error: 'invalid proof' });
          return;
        }

        const { gasEstimate } = await pool.preflight(request);

        // Serialised: one in-flight transaction per hot wallet, always.
        //
        // The spent check moves inside the lock as well. preflight runs
        // concurrently, so twenty copies of one valid proof all passed it
        // before the first was mined; the first spent the note and the rest
        // were broadcast, reverted on chain at the contract's own
        // already-spent guard, and cost the relayer gas for nothing. Rechecking
        // here — after every earlier submission has settled — is what makes the
        // duplicates free to reject.
        const result = await queue.run(async () => {
          await pool.assertUnspent(request);
          return pool.submit(request, gasEstimate);
        });
        res.json(result);
      } catch (e) {
        if (e instanceof RelayRejected) {
          res.status(e.status).json({ error: e.message });
          return;
        }
        console.error('[relay] unexpected failure:', (e as Error).message);
        res.status(500).json({ error: 'relay failed' });
      }
    },
  );

  return app;
}
