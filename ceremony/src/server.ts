import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { extendsChain, readChain } from './chain.js';
import { CeremonyState, sha256File } from './state.js';
import type { Config } from './config.js';

/** Generous: a valid upload is ~20 MB, and anything wildly over is not one. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const optionalAddress = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'not an address')
  .optional()
  .nullable();

const optionalLabel = z
  .string()
  .trim()
  .max(48)
  // A label is decoration on a transcript whose integrity comes from hashes.
  // Control characters and markup in it buy nothing and have to be escaped
  // everywhere it is rendered, so they are refused at the door instead.
  .regex(/^[\w .\-@]*$/u, 'letters, digits, spaces, . - @ _ only')
  .optional()
  .nullable();

const claimBody = z.object({
  displayName: optionalLabel,
  address: optionalAddress,
});

const attestBody = z.object({
  handle: optionalLabel,
  address: optionalAddress,
  zkeySha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export function createServer(cfg: Config, state: CeremonyState): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  /** Pending metadata for the live slot, keyed by token. */
  const pending = new Map<string, { displayName: string | null; address: string | null }>();

  const publicStatus = () => {
    const slot = state.slot();
    return {
      contributions: state.count(),
      circuitHash: state.transcript().circuitHash,
      startedAt: state.transcript().startedAt,
      drandRound: state.transcript().drandRound,
      finalised: state.transcript().finalised,
      // The token is never published — only whether someone holds the chain.
      slotOpen: slot === null && !state.isFinalised(),
      busy: state.isBusy(),
      slotExpiresAt: slot ? new Date(slot.expiresAt).toISOString() : null,
    };
  };

  app.get('/health', (_req, res) => {
    res.json({ ok: true, ...publicStatus() });
  });

  app.get('/status', (_req, res) => {
    res.json(publicStatus());
  });

  /**
   * The whole transcript, including addresses.
   *
   * Public on purpose: a ceremony nobody can audit is worth nothing, and the
   * addresses were given for a published airdrop record. The page says so
   * before anyone types one in.
   */
  app.get('/transcript', (_req, res) => {
    res.json(state.transcript());
  });

  /** The current key, for contributors and for anyone who wants to verify. */
  app.get('/zkey', (_req, res) => {
    res.type('application/octet-stream');
    res.setHeader('content-disposition', 'attachment; filename="current.zkey"');
    // No long-lived caching: this file changes with every contribution, and a
    // stale copy would be rejected by the prefix check with a confusing error.
    res.setHeader('cache-control', 'no-store');
    res.sendFile(path.resolve(state.currentZkeyPath));
  });

  app.post('/slot', async (req: Request, res: Response) => {
    if (state.isFinalised()) {
      res.status(409).json({ error: 'the ceremony is finalised' });
      return;
    }
    const body = claimBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? 'bad request' });
      return;
    }
    if (state.slot()) {
      const slot = state.slot()!;
      res.status(409).json({
        error: 'someone is contributing right now',
        retryAfter: new Date(slot.expiresAt).toISOString(),
      });
      return;
    }

    const baseSha256 = await sha256File(state.currentZkeyPath);
    const slot = state.claimSlot(baseSha256, cfg.SLOT_TTL_SECONDS);
    if (!slot) {
      res.status(409).json({ error: 'someone is contributing right now' });
      return;
    }
    pending.set(slot.token, {
      displayName: body.data.displayName ?? null,
      address: body.data.address ?? null,
    });

    res.json({
      token: slot.token,
      expiresAt: new Date(slot.expiresAt).toISOString(),
      baseSha256,
      contributionsBefore: state.count(),
      zkeyUrl: '/ceremony/zkey',
    });
  });

  app.post(
    '/contribute',
    express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
    async (req: Request, res: Response) => {
      const token = String(req.query.token ?? '');
      if (!state.beginUpload(token)) {
        res.status(409).json({
          error:
            'no live slot for that token — it expired, it was never issued, or ' +
            'an upload is already being verified',
        });
        return;
      }

      const upload = path.join(state.uploadsDir, `${randomUUID()}.zkey`);

      // The outcome is decided, then cleaned up after, and only then sent.
      // Responding first leaves the client free to poll /status before the
      // `finally` block has released anything, so a rejected contributor is
      // told to retry and immediately sees "someone is contributing right now"
      // — pointing at themselves.
      let status = 400;
      let payload: Record<string, unknown> = { error: 'upload failed' };
      let accepted = false;

      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          payload = { error: 'empty upload' };
        } else {
          await pipeline([body], createWriteStream(upload));
          const report = await readChain(upload, cfg.R1CS_PATH, cfg.PTAU_PATH);

          if (!report.valid) {
            payload = { error: 'the uploaded key does not verify against the circuit' };
          } else {
            const extension = extendsChain(state.contributions(), report.contributions);
            if (!extension.ok) {
              payload = { error: extension.reason };
            } else {
              const meta = pending.get(token) ?? { displayName: null, address: null };
              const record = await state.accept(extension.added, meta, upload);
              pending.delete(token);
              accepted = true;
              status = 200;
              payload = {
                accepted: true,
                index: record.index,
                hash: record.hash,
                zkeySha256: record.zkeySha256,
                contributions: state.count(),
              };
            }
          }
        }
      } catch (e) {
        payload = { error: (e as Error).message.slice(0, 300) };
      }

      // Anything that did not become the chain is deleted rather than kept for
      // inspection: a rejected upload is a 20 MB file of unknown provenance,
      // and there is no question it could answer that the error does not.
      await state.discardUpload(upload).catch(() => {});
      state.endUpload();

      // A rejected upload releases the slot. `accept` already released it on
      // success; holding it on failure meant one bad file locked the chain for
      // the rest of the slot's twenty minutes — a trivial denial of service,
      // and a miserable outcome for someone whose upload merely got truncated.
      // Retrying means claiming again, which hands out the current key.
      if (!accepted) {
        pending.delete(token);
        state.releaseSlot();
      }

      res.status(status).json(payload);
    },
  );

  /**
   * A verifier saying they checked the chain.
   *
   * Recorded, not trusted. The zkey hash is public, so this proves intent and
   * nothing more — which is why the page describes verifiers as having
   * confirmed the transcript rather than as having established anything about
   * the ceremony's safety, and why the reward attached to it is small.
   */
  app.post('/attest', async (req: Request, res: Response) => {
    const body = attestBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? 'bad request' });
      return;
    }
    const current = await sha256File(state.currentZkeyPath);
    if (body.data.zkeySha256 !== current) {
      res.status(409).json({
        error: 'that is not the current key — the chain moved on, verify again',
        current,
      });
      return;
    }
    await state.attest({
      address: body.data.address ?? null,
      handle: body.data.handle ?? null,
      zkeySha256: body.data.zkeySha256,
      contributionCount: state.count(),
    });
    res.json({ recorded: true, contributions: state.count() });
  });

  return app;
}
