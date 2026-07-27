import { useEffect, useState } from 'react';
import { useStrata } from '../lib/useStrata';
import { useCountUp } from '../lib/useCountUp';
import { count, denomLabel, eth, ethAuto, pct } from '../lib/format';
import { DotField } from '../components/DotField';
import { PrivacyScore } from '../components/PrivacyScore';
import { Steps } from '../components/Steps';
import { WalletChip, WalletGate } from '../components/WalletChip';
import { Lockup } from '../components/Logo';
import { SocialLinks, X_URL, GITHUB_URL } from '../components/Social';
import { initAppKit } from '../config/appkit';
import { isLive } from '../lib/usePool';
import { noteVault } from '../lib/noteVault';
import type { DepositReceipt, PoolClient, PoolState, WithdrawReceipt } from '../lib/types';
import type { useWallet } from '../lib/useWallet';

type Wallet = ReturnType<typeof useWallet>;

// Initialised here rather than in main.tsx so that AppKit — and the wallet
// connectors it pulls in — land in this route's chunk instead of the entry
// bundle. The landing page needs none of it.
initAppKit();

type Tab = 'deposit' | 'transfer' | 'withdraw' | 'pool';

const TABS: { key: Tab; label: string }[] = [
  { key: 'deposit', label: 'Deposit' },
  { key: 'transfer', label: 'Transfer' },
  { key: 'withdraw', label: 'Withdraw' },
  { key: 'pool', label: 'Pool' },
];

export function PoolApp() {
  const [tab, setTab] = useState<Tab>('deposit');
  /** Carried from the Transfer tab so paying someone is one continuous flow. */
  const [prefilledRecipient, setPrefilledRecipient] = useState('');
  const { pool, state, balance, live, wallet, ready, error, loaded } = useStrata();

  return (
    <>
      <div style={{ borderBottom: 'var(--rule)', background: 'var(--paper)', position: 'sticky', top: 0, zIndex: 50 }}>
        <div className="shell app-header">
          <a href="#/" style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', padding: '20px 0' }}>
            <Lockup size={26} />
            <span style={{ fontSize: 10, letterSpacing: '.2em', color: 'var(--ink-45)' }}>APP</span>
          </a>
          <div className="app-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 22px',
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  background: 'transparent',
                  cursor: 'pointer',
                  border: 0,
                  borderBottom: `2.5px solid ${tab === t.key ? 'var(--ink)' : 'transparent'}`,
                  color: tab === t.key ? 'var(--ink)' : 'var(--ink-55)',
                  marginBottom: -1.5,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <SocialLinks />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.25 }}>
              <span className="eyebrow" style={{ fontSize: 10, letterSpacing: '.18em' }}>Private balance</span>
              <span className="display tabular" style={{ fontWeight: 600, fontSize: 18 }}>
                {ready ? `${ethAuto(balance)} ETH` : '—'}
              </span>
            </div>
            <WalletChip wallet={wallet} live={live} />
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            borderBottom: 'var(--rule)',
            background: 'var(--alarm)',
            color: 'var(--paper)',
            padding: '12px 56px',
            fontSize: 12.5,
            letterSpacing: '.04em',
          }}
        >
          Cannot read the pool: {error}
          {loaded ? '. Figures below are from the last successful read.' : '.'}
        </div>
      )}

      {/* Nothing below this point can be drawn honestly before a read has
          succeeded. The panels used to render the initial empty state — zero
          notes, zero ETH, and a privacy warning saying the set was empty and
          not to withdraw — which is a confident claim about someone's money
          built from no data. Depositing is broken here too: the derivation
          index comes from scanning the tree, so a deposit made against an
          unread pool reuses index zero and the contract rejects it. */}
      {live && !loaded ? (
        <div className="shell-narrow page-in">
          {/* Reading and failing are different things and must not look alike.
              The first scan walks every block since deployment, so on a cold
              load there is a real wait before any figure exists — showing the
              failure copy through it would report a working site as a broken
              one. `error` is the only thing that distinguishes them. */}
          <PageHead
            title={error ? 'Cannot read the pool' : 'Reading the pool'}
            meta={error ? 'no data — nothing below would be true' : 'scanning every block since deployment'}
          />
          <div className="card-hero" style={{ maxWidth: 640 }}>
            <div style={{ fontSize: 13.5, lineHeight: 1.8, color: 'var(--ink-70)' }}>
              {error ? (
                <>
                  The RPC is not answering, so this page has no figures to show
                  — not zero notes and not an empty pool, but no information at
                  all. It retries every 15 seconds and this screen will go away
                  on its own; nothing needs to be reloaded.
                </>
              ) : (
                <>
                  Every deposit since the pool was deployed is being read
                  straight from the chain — there is no server holding an index
                  of them, which is why this takes a moment and why nobody can
                  hand you a doctored one.
                </>
              )}
              <br />
              <br />
              Your notes are unaffected either way: they live in the contract
              and are derived from your wallet signature, so nothing on this
              screen can lose them.
            </div>
            <div className="eyebrow" style={{ marginTop: 24, color: 'var(--ink-45)' }}>
              Pool {import.meta.env.VITE_POOL_ADDRESS} · chain 4663
            </div>
          </div>
        </div>
      ) : (
        <>

      {tab === 'deposit' &&
        (ready ? <Deposit pool={pool} state={state} /> : <Gated title="Deposit" wallet={wallet} />)}
      {tab === 'transfer' &&
        (ready ? (
          <Transfer
            pool={pool}
            onSendToAddress={(a) => {
              setPrefilledRecipient(a);
              setTab('withdraw');
            }}
          />
        ) : (
          <Gated title="Transfer" wallet={wallet} />
        ))}
      {tab === 'withdraw' &&
        (ready ? (
          <Withdraw pool={pool} balance={balance} initialRecipient={prefilledRecipient} />
        ) : (
          <Gated title="Withdraw" wallet={wallet} />
        ))}
      {/* Pool stats are public data — no wallet needed to look at the set. */}
      {tab === 'pool' && <PoolStats state={state} />}
        </>
      )}

      <AppFooter />
    </>
  );
}

/**
 * The app runs as its own route, so a visitor who lands here from a shared
 * link never passes the landing page and its footer. Without this there is no
 * route to the source from inside the product — and "read the code before
 * depositing" is not advice you can give while hiding the link.
 */
function AppFooter() {
  const link = { color: 'var(--ink-55)', textDecoration: 'none' } as const;
  return (
    <div className="shell app-footer">
      <span>STRATA · PRIVACY POOL</span>
      <span className="app-footer-chain">ROBINHOOD CHAIN 4663 · ETH</span>
      <span style={{ display: 'flex', gap: 20 }}>
        <a href={X_URL} target="_blank" rel="noopener noreferrer" style={link}>
          X
        </a>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={link}>
          GITHUB
        </a>
      </span>
    </div>
  );
}

function Gated({ title, wallet }: { title: string; wallet: Wallet }) {
  return (
    <div className="shell-narrow page-in">
      <PageHead title={title} meta="wallet required" />
      <div className="split">
        <WalletGate wallet={wallet} />
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 16 }}>What we never see</div>
          {[
            ['Your note keys', 'derived in your browser, never sent'],
            ['Which note is yours', 'hidden by the proof, by construction'],
            ['Your private balance', 'computed locally from public data'],
          ].map(([k, v]) => (
            <div
              key={k}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 0',
                borderTop: '1px solid var(--ink-12)',
                fontSize: 12.5,
              }}
            >
              <span style={{ color: 'var(--ink-55)', flex: 'none' }}>{k}</span>
              <span style={{ textAlign: 'right' }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The site-wide banner was dropped, so this is the only place the risk is
 * stated. It sits immediately above the deposit button on purpose: it is the
 * last thing read before funds are committed, and the contract has no cap,
 * no pause and no upgrade path to fall back on if the circuit is wrong.
 */
function RiskNote() {
  if (!isLive()) return null;
  return (
    <div
      style={{
        border: '1px solid var(--ink-25)',
        padding: '12px 14px',
        marginBottom: 16,
        fontSize: 12,
        lineHeight: 1.7,
        color: 'var(--ink-70)',
      }}
    >
      No completed audit — one is being arranged. The circuit is Tornado Cash
      v1's, unchanged, and passes static analysis — but the contract cannot be
      paused or upgraded, and nothing limits what a bug could take.{' '}
      <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
        Read the code
      </a>{' '}
      before depositing.
    </div>
  );
}

function PageHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 40 }}>
      <h1 className="display h-page" style={{ margin: 0, fontWeight: 600 }}>
        {title} <span className="star" style={{ fontSize: 28, verticalAlign: '.25em' }}>✳</span>
      </h1>
      <span className="eyebrow" style={{ letterSpacing: '.24em' }}>{meta}</span>
    </div>
  );
}

/**
 * Wallet and RPC errors arrive as long, nested objects. Users need the one
 * sentence that tells them whether they refused, ran out of gas, or hit a
 * contract rule — not a stack trace, and not a silent stall.
 */
/**
 * A percentage that does not round a live figure to zero.
 *
 * Two decimals is right once the reserve is a percent or so of the pool. Below
 * that it prints 0.00% — indistinguishable from a pool that has never paid a
 * fee, on the one screen whose job is to report what is actually there.
 */
function sharePct(v: number): string {
  if (v === 0) return '0';
  if (v >= 1) return pct(v);
  return v.toFixed(Math.min(6, Math.max(2, Math.ceil(-Math.log10(v)) + 1)));
}

/**
 * Note age in whatever unit makes it legible.
 *
 * The figure is used to judge whether a note has sat long enough to be worth
 * withdrawing, so the first hours are exactly the range that matters, and
 * exactly the range "0.0d" erases.
 */
function noteAge(days: number): string {
  if (days <= 0) return '—';
  if (days >= 1) return `${days.toFixed(1)}d`;
  const hours = days * 24;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.max(1, Math.round(hours * 60))}m`;
}

function readableError(e: unknown): string {
  const err = e as { shortMessage?: string; reason?: string; code?: string | number; message?: string };
  if (err?.code === 'ACTION_REJECTED' || err?.code === 4001) {
    return 'You rejected the request in your wallet.';
  }
  const raw = err?.shortMessage ?? err?.reason ?? err?.message ?? String(e);
  if (/insufficient funds/i.test(raw)) {
    return 'Not enough ETH in this wallet to cover the deposit plus gas.';
  }

  // A TypeError here is our bug, not a condition the user can act on, and the
  // message alone ("Cannot read properties of undefined") names neither the
  // call nor the file. Appending the throwing frame turns a screenshot into
  // something diagnosable — the previous one cost an afternoon of reading code
  // to guess at a line the browser already knew.
  if (e instanceof TypeError || e instanceof ReferenceError) {
    const frame = (e.stack ?? '')
      .split('\n')
      .slice(1)
      .find((l) => /\S/.test(l))
      ?.trim()
      .slice(0, 120);
    return frame ? `${raw} — at ${frame}` : raw;
  }

  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

/**
 * What happened, stated plainly, in the same slot the error box uses.
 *
 * Both panels used to report success by filling in a four-step checklist in a
 * side column — below the fold on a phone — and returning the button to its
 * resting label. Nothing said the money had moved. A user who had just signed a
 * wallet prompt and watched the page go quiet could not distinguish a completed
 * deposit from one that never fired, and the honest response to that is to
 * check the explorer, which defeats the point of the panel.
 */
function Receipt({ lines, hashes }: { lines: string[]; hashes: string[] }) {
  return (
    <div
      className="receipt"
      style={{
        border: '1.5px solid var(--accent)',
        padding: '14px 16px',
        marginBottom: 16,
        fontSize: 12.5,
        lineHeight: 1.75,
      }}
    >
      <div className="eyebrow" style={{ color: 'var(--accent)', marginBottom: 8 }}>
        Confirmed on chain
      </div>
      {lines.map((l) => (
        <div key={l} style={{ color: 'var(--ink-70)' }}>
          {l}
        </div>
      ))}
      {hashes.length > 0 && (
        <div
          className="tabular"
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: 'var(--rule)',
            fontSize: 11,
            color: 'var(--ink-55)',
            wordBreak: 'break-all',
          }}
        >
          {/* One hash per note: deposits and withdrawals are deliberately not
              batched, so a multi-note action really is several transactions. */}
          {hashes.map((h) => (
            <div key={h}>{h}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The same confirmation, in front of you rather than beside you.
 *
 * The inline receipt was still missable: the wallet popup has just closed,
 * focus is somewhere else, and on a phone the panel may not be the part of the
 * page in view. A confirmation you have to go looking for is the failure it was
 * meant to fix. Dismissing this leaves the inline receipt in place, so the
 * hash is still there to copy afterwards.
 */
function ReceiptModal({
  title,
  lines,
  hashes,
  onClose,
}: {
  title: string;
  lines: string[];
  hashes: string[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <svg viewBox="0 0 96 96" width="92" height="92" aria-hidden="true" style={{ marginBottom: 16, display: 'block' }}>
          <circle className="tick-wave" cx="48" cy="48" r="30" />
          <circle className="tick-disc" cx="48" cy="48" r="30" />
          <path className="tick-path" d="M32 49 L43 60 L65 36" />
        </svg>
        <div className="eyebrow" style={{ color: 'var(--accent)', marginBottom: 10 }}>
          Confirmed on chain
        </div>
        <div style={{ fontSize: 22, lineHeight: 1.35, marginBottom: 16 }}>{title}</div>
        {lines.map((l) => (
          <div key={l} style={{ fontSize: 13, lineHeight: 1.75, color: 'var(--ink-70)', marginBottom: 8 }}>
            {l}
          </div>
        ))}
        {hashes.length > 0 && (
          <div
            className="tabular"
            style={{
              marginTop: 16,
              paddingTop: 14,
              borderTop: 'var(--rule)',
              fontSize: 10.5,
              color: 'var(--ink-55)',
              wordBreak: 'break-all',
              lineHeight: 1.6,
            }}
          >
            {hashes.map((h) => (
              <div key={h}>{h}</div>
            ))}
          </div>
        )}
        <button className="btn" style={{ marginTop: 22 }} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

const DEPOSIT_STEPS = [
  'Derive private keys from wallet signature',
  'Generate commitments',
  'Submit to Robinhood Chain',
  'Merge into the anonymity set',
];

function Deposit({ pool, state }: { pool: PoolClient; state: PoolState }) {
  const openTier = state.tiers.find((t) => t.open);
  // Default to one note of whatever this pool actually accepts, rather than a
  // hardcoded 2.3 that is meaningless against a 0.01 denomination.
  const [amount, setAmount] = useState(() => String(openTier?.value ?? 0.1));
  const [step, setStep] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DepositReceipt | null>(null);
  const [shout, setShout] = useState(false);

  const parsed = Number(amount) || 0;
  const split = pool.splitAmount(parsed);
  const gas = pool.estimateDepositGas(split.totalNotes);

  // Without a catch here a rejected wallet prompt or a reverted transaction
  // left the button reading "Depositing…" forever with the real error
  // swallowed — the user could not tell a refusal from a hang.
  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await pool.deposit({ amount: parsed }, setStep));
      setShout(true);
      setStep(DEPOSIT_STEPS.length);
    } catch (e) {
      setError(readableError(e));
      setStep(-1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell-narrow page-in">
      {shout && done && (
        <ReceiptModal
          title={`${eth(done.amount, 4)} ETH deposited`}
          lines={[
            `${count(done.notes)} note${done.notes === 1 ? '' : 's'} added to the anonymity set.`,
            'Wait before withdrawing. Deposits that land while you wait sit behind yours and dilute the timing correlation.',
          ]}
          hashes={done.hashes}
          onClose={() => setShout(false)}
        />
      )}
      <PageHead title="Deposit" meta="Deposit · no protocol fee" />
      <div className="split">
        <div className="card-hero">
          <div className="eyebrow" style={{ marginBottom: 14 }}>Denominations</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            {state.tiers.map((t) => (
              <span key={t.value} className={t.open ? 'chip' : 'chip chip-locked'}>
                {denomLabel(t.value)} ETH
                {!t.open && <span style={{ fontSize: 10, letterSpacing: '.1em' }}>PLANNED</span>}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-55)', marginBottom: 30, lineHeight: 1.7 }}>
            This pool has one fixed note size, set when it was deployed and
            unchangeable. Other sizes are separate contracts with separate
            anonymity sets; running them too early would split the cover between
            them.
          </div>

          <div className="eyebrow" style={{ marginBottom: 6 }}>Amount</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, borderBottom: 'var(--rule)', padding: '8px 0 12px' }}>
            {/* Clearing the receipt on edit: a confirmation left standing while
                the amount changes underneath it describes a deposit that no
                longer matches what the button is about to do. */}
            <input
              className="amount-input"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setDone(null);
              }}
              inputMode="decimal"
            />
            <span style={{ fontSize: 17, color: 'var(--ink-55)' }}>ETH</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0 30px' }}>
            {/* Multiples of this pool's actual note size, not fixed amounts —
                a "1 ETH" shortcut on a 0.01 pool means 100 separate deposits. */}
            {[1, 5, 10, 25].map((n) => {
              const v = Number(((openTier?.value ?? 0.1) * n).toFixed(6));
              return (
                <button key={n} className="quick" onClick={() => { setAmount(String(v)); setDone(null); }}>
                  {v} ETH
                </button>
              );
            })}
          </div>

          <div className="hatch" style={{ border: '1px solid var(--ink-25)', padding: 20, marginBottom: 30 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
              <span className="eyebrow">Auto-split</span>
              <span className="eyebrow tabular">{split.totalNotes} notes</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {split.parts.map((p) => (
                <span key={p.denomination} className="chip tabular" style={{ padding: '8px 14px', fontSize: 13.5 }}>
                  {p.count} × {denomLabel(p.denomination)} ETH
                </span>
              ))}
              <span className="tabular" style={{ fontSize: 13, color: 'var(--ink-55)' }}>
                = {eth(split.coveredAmount, 4)} ETH
              </span>
            </div>

            {split.remainder > 0 && openTier ? (
              /* Fixed denominations cannot express arbitrary amounts. Surfacing
                 that here rather than at confirmation is the whole point. */
              <div style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--alarm)', marginTop: 12, fontWeight: 500 }}>
                {eth(split.remainder, 4)} ETH cannot be deposited — amounts must be
                multiples of {denomLabel(openTier.value)} ETH. Only{' '}
                {ethAuto(split.coveredAmount)} ETH will go in.
              </div>
            ) : (
              <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--ink-55)', marginTop: 12 }}>
                Split into {split.totalNotes} identical notes. Each one is
                indistinguishable from every other note at this denomination.
              </div>
            )}
          </div>

          <RiskNote />

          {error && (
            <div
              style={{
                border: '1.5px solid var(--alarm)',
                padding: '12px 14px',
                marginBottom: 16,
                fontSize: 12.5,
                lineHeight: 1.7,
                color: 'var(--alarm)',
                fontWeight: 500,
              }}
            >
              {error}
            </div>
          )}

          {done && (
            <Receipt
              lines={[
                `${eth(done.amount, 4)} ETH is in the pool as ${count(done.notes)} note${done.notes === 1 ? '' : 's'}.`,
                'The keys are derived from your wallet signature, so this note is recoverable on any device that can sign with the same wallet — there is nothing here to write down.',
              ]}
              hashes={done.hashes}
            />
          )}

          <button className="btn" onClick={run} disabled={busy || split.totalNotes === 0}>
            {busy ? 'Depositing…' : `Deposit ${eth(split.coveredAmount, 4)} ETH`}
          </button>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 11, letterSpacing: '.08em', color: 'var(--ink-55)' }} className="tabular">
            <span>EST. GAS · {eth(gas, 6)} ETH</span>
            <span>NO PROTOCOL FEE</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <Steps labels={DEPOSIT_STEPS} current={step} />
          <div className="card" style={{ background: 'transparent' }}>
            <div className="eyebrow" style={{ marginBottom: 16 }}>After you deposit</div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <span style={{ color: 'var(--accent)', flex: 'none' }}>◷</span>
              <span style={{ fontSize: 13, lineHeight: 1.75, color: 'var(--ink-70)' }}>
                Wait before withdrawing. Deposits made while you wait land behind
                yours and dilute the timing correlation. The Withdraw tab tells you
                how much waiting is currently worth.
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <span style={{ color: 'var(--accent)', flex: 'none' }}>⊘</span>
              <span style={{ fontSize: 13, lineHeight: 1.75, color: 'var(--ink-70)' }}>
                On-chain, all anyone sees is that an address deposited a fixed
                denomination. Your withdrawal address has no link to it.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Transfer({
  pool,
  onSendToAddress,
}: {
  pool: PoolClient;
  onSendToAddress: (address: string) => void;
}) {
  const [mode, setMode] = useState<'address' | 'note'>('address');
  const [address, setAddress] = useState('');
  const [howMany, setHowMany] = useState('1');
  const [exported, setExported] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [incoming, setIncoming] = useState('');
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const notes = pool.getNotes();
  const available = notes.length;
  const denomination = notes[0]?.denomination ?? 0.1;
  const wanted = Math.max(0, Math.floor(Number(howMany) || 0));

  const run = async () => {
    setBusy(true);
    setCopied(false);
    try {
      const out = await pool.exportNotes(notes.slice(0, wanted).map((n) => n.id));
      setExported(out.map((o) => o.encoded));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(exported.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    const blob = new Blob([exported.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'strata-notes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const runImport = async () => {
    setImporting(true);
    setImportMsg(null);
    try {
      const res = await pool.importNote(incoming);
      if (res.ok) {
        setIncoming('');
        setImportMsg({
          ok: true,
          text: `Imported. ${res.denomination} ETH added to your private balance — withdraw it soon, since whoever gave it to you can still spend it.`,
        });
      } else {
        setImportMsg({ ok: false, text: res.reason });
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="shell-narrow page-in">
      <PageHead title="Transfer" meta="Transfer" />
      <div className="split">
        <div className="card-hero">
          {/* Fixed-denomination pools have no in-pool transfer. These two are
              what the protocol can actually do, and they trade off differently. */}
          {(
            [
              {
                key: 'address' as const,
                title: 'Withdraw to their address',
                cost: '0.3% fee',
                body: 'They give you a normal wallet address. They never need to touch Strata, install anything, or know this exists. Atomic — neither side has to trust the other.',
              },
              {
                key: 'note' as const,
                title: 'Hand them the note',
                cost: 'free · no transaction',
                body: 'Give them the note key directly, over any channel you like. Nothing happens on-chain at all — there is no transfer to observe.',
                warn: 'You still hold a copy of the key, so you could spend the note first. This is not atomic. Only use it with people you trust, and tell them to withdraw promptly.',
              },
            ]
          ).map((o) => {
            const on = mode === o.key;
            return (
              <button
                key={o.key}
                onClick={() => setMode(o.key)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: 22,
                  marginBottom: 16,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: on ? 'var(--paper)' : 'transparent',
                  border: on ? 'var(--rule)' : '1px solid var(--ink-25)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 16 }}>{o.title}</span>
                  <span className="eyebrow" style={{ fontSize: 10 }}>{o.cost}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.75, color: 'var(--ink-70)' }}>{o.body}</div>
                {o.warn && (
                  <div style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--alarm)', marginTop: 10, fontWeight: 500 }}>
                    ⚠ {o.warn}
                  </div>
                )}
              </button>
            );
          })}

          {mode === 'address' ? (
            <>
              <div className="eyebrow" style={{ margin: '18px 0 6px' }}>Their wallet address</div>
              <input
                className="field"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                style={{ marginBottom: 24 }}
              />
              <button
                className="btn"
                disabled={!/^0x[0-9a-fA-F]{40}$/.test(address.trim())}
                onClick={() => onSendToAddress(address.trim())}
              >
                {/^0x[0-9a-fA-F]{40}$/.test(address.trim())
                  ? 'Continue to withdraw'
                  : 'Enter a valid address'}
              </button>
            </>
          ) : (
            <>
              <div className="eyebrow" style={{ margin: '18px 0 6px' }}>
                How many notes ({available} available)
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, borderBottom: 'var(--rule)', padding: '8px 0 12px', marginBottom: 20 }}>
                <input
                  className="amount-input"
                  style={{ fontSize: 40 }}
                  value={howMany}
                  onChange={(e) => setHowMany(e.target.value)}
                  inputMode="numeric"
                />
                <span style={{ fontSize: 15, color: 'var(--ink-55)' }}>
                  notes · {eth(wanted * denomination, 2)} ETH
                </span>
              </div>

              <button
                className="btn"
                disabled={wanted < 1 || wanted > available || busy}
                onClick={run}
              >
                {busy ? 'Exporting…' : `Export ${wanted || 0} note key${wanted === 1 ? '' : 's'}`}
              </button>

              {exported.length > 0 && (
                <div style={{ marginTop: 22 }}>
                  <div style={{ border: `1.5px solid var(--alarm)`, padding: '14px 16px', fontSize: 12.5, lineHeight: 1.7, color: 'var(--alarm)', fontWeight: 500, marginBottom: 14 }}>
                    ⚠ You still hold a copy of these keys, so you could spend
                    these notes before the recipient does. Nothing on-chain
                    prevents it. Only hand them to someone who is relying on
                    your word, and tell them to withdraw promptly.
                  </div>
                  <textarea
                    readOnly
                    value={exported.join('\n')}
                    onFocus={(e) => e.currentTarget.select()}
                    style={{
                      width: '100%',
                      minHeight: 120,
                      background: 'var(--paper)',
                      border: '1px solid var(--ink-25)',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      lineHeight: 1.7,
                      padding: 12,
                      resize: 'vertical',
                      wordBreak: 'break-all',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="quick" onClick={copy}>
                      {copied ? 'Copied' : 'Copy all'}
                    </button>
                    <button className="quick" onClick={download}>
                      Download .txt
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 10 }}>Who sees what</div>
            {[
              ['On-chain observer', 'a fixed-denomination withdrawal, source unknown'],
              ['Recipient', 'the amount, not you'],
              ['Relayer', 'the destination, not where it came from'],
              ['Us', 'no keys. nothing.'],
            ].map(([k, v], i) => (
              <div
                key={k}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 0',
                  borderTop: '1px solid var(--ink-12)',
                  fontSize: 12.5,
                }}
              >
                <span style={{ color: 'var(--ink-55)', flex: 'none' }}>{k}</span>
                <span style={{ textAlign: 'right', color: i === 3 ? 'var(--accent)' : undefined, fontWeight: i === 3 ? 500 : undefined }}>
                  {v}
                </span>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 12 }}>Received a note?</div>
            <textarea
              value={incoming}
              onChange={(e) => setIncoming(e.target.value)}
              placeholder="strata-note-v1-…"
              style={{
                width: '100%',
                minHeight: 72,
                background: 'var(--paper)',
                border: '1px solid var(--ink-25)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                lineHeight: 1.7,
                padding: 10,
                resize: 'vertical',
                wordBreak: 'break-all',
                marginBottom: 12,
              }}
            />
            <button
              className="btn"
              disabled={!incoming.trim() || importing}
              onClick={runImport}
            >
              {importing ? 'Checking against the chain…' : 'Import note'}
            </button>
            {importMsg && (
              <div
                style={{
                  marginTop: 12,
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  color: importMsg.ok ? 'var(--accent)' : 'var(--alarm)',
                }}
              >
                {importMsg.text}
              </div>
            )}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--ink-12)', fontSize: 12, lineHeight: 1.7, color: 'var(--ink-55)' }}>
              Imported notes live only in this browser — their keys came from
              someone else's wallet, so signing in elsewhere will not find them.
              Keep the original string until you have withdrawn.
              {/* The previous version stopped at the line above, which reads as
                  reassurance. Both halves of the actual situation were missing:
                  the keys sit unencrypted, and the browser's own "clear site
                  data" destroys the money. */}
              <div style={{ marginTop: 8 }}>
                They are stored <b style={{ color: 'var(--ink-70)' }}>unencrypted</b>{' '}
                in this browser's local storage. Clearing site data deletes them
                and the funds with them, unless you still hold the string.
              </div>
              <ForgetImported />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Removes imported notes from this browser.
 *
 * noteVault.clear() existed and nothing called it, so a note handed over on a
 * shared or borrowed machine stayed there permanently with no way to remove it
 * short of wiping the whole origin — which would also take the AppKit balance
 * cache keyed by the user's own address, and any other note.
 */
function ForgetImported() {
  const [count, setCount] = useState(() => noteVault.all().length);
  const [confirming, setConfirming] = useState(false);
  if (count === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <button
        className="quick"
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          noteVault.clear();
          setCount(0);
          setConfirming(false);
        }}
        style={confirming ? { borderColor: 'var(--alarm)', color: 'var(--alarm)' } : undefined}
      >
        {confirming
          ? `Really forget ${count}? Unwithdrawn notes are lost without the string`
          : `Forget ${count} imported note${count === 1 ? '' : 's'} on this device`}
      </button>
    </div>
  );
}

const WITHDRAW_STEPS = [
  'Building zero-knowledge proof',
  'Splitting the 0.3%',
  'Submitting nullifier',
  'Funds delivered',
];

function Withdraw({
  pool,
  balance,
  initialRecipient = '',
}: {
  pool: PoolClient;
  balance: number;
  initialRecipient?: string;
}) {
  // Default to something the user can actually withdraw — during cold start the
  // balance is a few notes, and pre-filling more than that just shows an error.
  const [amount, setAmount] = useState(() => String(Math.min(0.5, balance)));
  const [recipient, setRecipient] = useState(initialRecipient);
  const [step, setStep] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<WithdrawReceipt | null>(null);
  const [shout, setShout] = useState(false);

  const parsed = Number(amount) || 0;
  const quote = pool.quoteWithdrawal(parsed);
  const assessment = pool.assessPrivacy();
  const tooMuch = parsed > balance;

  // Fetch the 20 MB proving key while the tab is being read, not at the moment
  // of withdrawal. Doing it inside prove() published the intent: a large
  // transfer, then a small POST, then an on-chain withdrawal, seconds apart and
  // trivially recognisable to anyone watching the connection.
  useEffect(() => {
    void pool.warmUpProver?.();
  }, [pool]);

  const run = async () => {
    if (assessment.requiresConfirmation && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await pool.withdraw({ recipient, amount: parsed }, setStep));
      setShout(true);
      setStep(WITHDRAW_STEPS.length);
    } catch (e) {
      // Withdrawals fail for reasons the user can act on — the relayer being
      // out of gas, a stale root, a note already spent. Surfacing the message
      // is the difference between retrying and assuming the funds are gone.
      setError(readableError(e));
      setStep(-1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell-narrow page-in">
      {shout && done && (
        <ReceiptModal
          title={`${eth(done.received, 6)} ETH withdrawn`}
          lines={[
            `Sent to ${done.recipient}.`,
            `${count(done.notes)} note${done.notes === 1 ? '' : 's'} spent. Nothing on chain connects that address to the one that deposited.`,
          ]}
          hashes={done.hashes}
          onClose={() => setShout(false)}
        />
      )}
      <PageHead title="Withdraw" meta="Withdraw · 0.3%" />
      <div className="split">
        <div className="card-hero">
          <div className="eyebrow" style={{ marginBottom: 6 }}>Withdraw to (use a fresh address)</div>
          <input
            className="field"
            value={recipient}
            onChange={(e) => { setRecipient(e.target.value); setDone(null); }}
            placeholder="0x… never used before"
            style={{ marginBottom: 34 }}
          />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <span className="eyebrow">Amount</span>
            <span className="eyebrow tabular" style={{ letterSpacing: '.08em' }}>Private balance {ethAuto(balance)} ETH</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, borderBottom: 'var(--rule)', padding: '8px 0 12px', marginBottom: 28 }}>
            <input
              className="amount-input"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setDone(null); }}
              inputMode="decimal"
            />
            <span style={{ fontSize: 17, color: 'var(--ink-55)' }}>ETH</span>
          </div>

          <div
            style={{
              display: 'flex',
              height: 14,
              border: 'var(--rule)',
              overflow: 'hidden',
              marginBottom: 10,
              animation: 'sweepIn .9s .2s cubic-bezier(.2,.7,.2,1) both',
              transformOrigin: 'left',
            }}
          >
            <div style={{ width: '99.7%', background: 'repeating-linear-gradient(-45deg,#fdfdfc 0 7px,rgba(17,17,16,.12) 7px 9px)' }} />
            <div style={{ width: '0.2%', minWidth: 8, background: '#35d3b0', animation: 'ringPulse 2.2s ease-out infinite' }} />
            <div style={{ width: '0.1%', minWidth: 8, background: '#f0ee5a', animation: 'ringPulse 2.2s .6s ease-out infinite' }} />
          </div>
          <div className="tabular" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, letterSpacing: '.1em', color: 'var(--ink-55)', marginBottom: 24 }}>
            <span>You receive {eth(quote.net)} ETH</span>
            <span>relayer {eth(quote.relayerFee)} · reserve {eth(quote.reserveFee)}</span>
          </div>

          <div style={{ border: '1px solid var(--ink-25)', padding: '16px 18px', fontSize: 12.5, lineHeight: 1.75, color: 'var(--ink-70)', marginBottom: 30 }}>
            0.2% pays the relayer that fronts your gas, so this address can start
            empty. 0.1% goes to the pool reserve, which has no withdrawal function.
          </div>

          {error && (
            <div
              style={{
                border: '1.5px solid var(--alarm)',
                padding: '12px 14px',
                marginBottom: 16,
                fontSize: 12.5,
                lineHeight: 1.7,
                color: 'var(--alarm)',
                fontWeight: 500,
              }}
            >
              {error}
            </div>
          )}

          {confirming && (
            <div style={{ border: `1.5px solid var(--alarm)`, padding: '16px 18px', fontSize: 13, lineHeight: 1.75, color: 'var(--alarm)', marginBottom: 16, fontWeight: 500 }}>
              {assessment.headline}. Withdrawing now is close to publishing the link
              yourself. Press again to proceed anyway.
            </div>
          )}

          {done && (
            <Receipt
              lines={[
                `${eth(done.received, 6)} ETH sent to ${done.recipient}.`,
                `${count(done.notes)} note${done.notes === 1 ? '' : 's'} spent. Nothing on chain connects that address to the one that deposited.`,
              ]}
              hashes={done.hashes}
            />
          )}

          <button
            className={confirming ? 'btn btn-alarm' : 'btn'}
            onClick={run}
            disabled={busy || parsed <= 0 || tooMuch}
          >
            {busy
              ? 'Generating proof…'
              : tooMuch
                ? 'Exceeds private balance'
                : confirming
                  ? 'Withdraw anyway'
                  : 'Generate proof & withdraw'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <PrivacyScore a={assessment} />
          <Steps labels={WITHDRAW_STEPS} current={step} />
        </div>
      </div>
    </div>
  );
}

function PoolStats({ state }: { state: PoolState }) {
  const [pulse, setPulse] = useState(0);
  const maxBar = Math.max(...state.reserveHistory, 1e-9);
  const openTier = state.tiers.find((t) => t.open);

  // Deposits rain in continuously rather than on a button press: the landing
  // is the point, and making it opt-in meant most visitors never saw it.
  useEffect(() => {
    setPulse((p) => p + 3);
    const id = setInterval(() => setPulse((p) => p + 1), 3400);
    return () => clearInterval(id);
  }, []);

  const notesShown = useCountUp(state.totalUnspentNotes, 1400, 'pool');
  const tvlShown = useCountUp(state.totalEthInPool, 1400, 'pool');
  const depositorsShown = useCountUp(state.uniqueDepositors, 1400, 'pool');

  return (
    <>
      <div className="dotfield" style={{ borderBottom: 'var(--rule)', position: 'relative', background: 'var(--surface)', overflow: 'hidden' }}>
        <DotField
          count={state.totalUnspentNotes}
          pulseSignal={pulse}
          denomination={openTier?.value ?? 0.1}
        />
        <div className="dotfield-caption">
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Anonymity set · each dot is one unspent note
          </div>
          <div className="display tabular h-pool" style={{ fontWeight: 500, lineHeight: 1 }}>
            {count(notesShown)}
          </div>
          <div className="tabular" style={{ marginTop: 10, fontSize: 13, color: 'var(--ink-55)' }}>
            {ethAuto(tvlShown)} ETH in pool · {count(depositorsShown)} unique depositors
          </div>
        </div>
        <div
          className="dotfield-live"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 11,
            letterSpacing: '.18em',
            color: 'var(--ink-55)',
            pointerEvents: 'none',
            textTransform: 'uppercase',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--accent)',
              animation: 'blink 1.8s ease-in-out infinite',
            }}
          />
          Live · deposits keep landing, and land indistinguishable
        </div>
      </div>

      <div className="shell-narrow page-in" style={{ paddingTop: 52 }}>
        <div className="pool-grid">
          <div>
            <div className="eyebrow" style={{ marginBottom: 18 }}>Denominations</div>
            <div style={{ borderTop: 'var(--rule)' }}>
              {state.tiers.map((t, i) => (
                <div
                  key={t.value}
                  className="tabular tier-row"
                  style={{
                    padding: '15px 0',
                    borderBottom: '1px solid rgba(17,17,16,.15)',
                    color: t.open ? 'var(--ink)' : 'var(--ink-45)',
                    animation: `rowIn .6s cubic-bezier(.2,.7,.2,1) ${i * 0.07}s both`,
                  }}
                >
                  <span className="display" style={{ fontWeight: 500, fontSize: 24 }}>{denomLabel(t.value)}</span>
                  <span style={{ fontSize: 13.5 }}>{t.open ? `${count(t.unspentNotes)} unspent` : '—'}</span>
                  <span style={{ fontSize: 13.5, textAlign: 'right' }}>{t.open ? `${ethAuto(t.ethLocked)} ETH` : '—'}</span>
                  {/* "LOCKED" implied an on-chain threshold that unlocks.
                      There is none — each size is a separate deployment with
                      its own anonymity set, so these are labelled as what
                      they are: a roadmap. */}
                  <span style={{ fontSize: 11, letterSpacing: '.08em', textAlign: 'right', color: t.open ? 'var(--accent)' : 'var(--ink-45)' }}>
                    {t.open ? 'LIVE' : 'PLANNED'}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--ink-55)', marginTop: 14 }}>
              Each size is its own pool contract with its own anonymity set —
              nothing unlocks automatically. Running several at once would split
              the set between them, so a new one only launches when the live pool
              is thick enough to stand on its own.
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
                <span className="eyebrow">Reserve growth · last 12 weeks</span>
                <span className="tabular" style={{ fontSize: 12, color: 'var(--accent)' }}>+{eth(state.reserveEth, 4)} ETH</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 100, borderBottom: 'var(--rule)', position: 'relative', overflow: 'hidden' }}>
                {state.reserveHistory.map((v, i) => (
                  <div
                    key={i}
                    title={`week ${i - state.reserveHistory.length + 1}: ${eth(v, 4)} ETH`}
                    style={{
                      flex: 1,
                      height: `${Math.max(4, (v / maxBar) * 100)}%`,
                      background: 'linear-gradient(180deg,#35d3b0,#a9e86b)',
                      transformOrigin: 'bottom',
                      // Grow in on entry, then breathe — the last bar is the
                      // one still accruing, so it should not look settled.
                      animation:
                        i === state.reserveHistory.length - 1
                          ? `barGrow .7s cubic-bezier(.2,.7,.2,1) ${i * 0.04}s both, barLive 2.4s ${0.7 + i * 0.04}s ease-in-out infinite alternate`
                          : `barGrow .7s cubic-bezier(.2,.7,.2,1) ${i * 0.04}s both`,
                      transition: 'filter .25s',
                    }}
                  />
                ))}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: '34%',
                    background:
                      'linear-gradient(100deg,transparent,rgba(253,253,252,.5) 50%,transparent)',
                    animation: 'sheenX 3.2s ease-in-out infinite',
                    pointerEvents: 'none',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10, letterSpacing: '.16em', color: 'var(--ink-45)' }}>
                <span>W-12</span>
                <span>THIS WEEK</span>
              </div>
            </div>

            <div className="quad">
              {[
                // Guarding the divisor with 1e-9 turned an empty pool into
                // "5,000,000.00%". There is no meaningful share of nothing.
                [
                  'Reserve share of pool',
                  // Two fixed decimals printed 0.002% as "0.00%" — a real,
                  // growing number rendered as nothing. The reserve is 0.1% of
                  // each withdrawal against the whole pool's principal, so it
                  // is small by construction and stays small for a long time.
                  state.totalEthInPool > 0
                    ? `${sharePct((state.reserveEth / state.totalEthInPool) * 100)}%`
                    : '—',
                  false,
                ],
                ['Anonymity set, 30d', `+${pct(state.anonSetGrowth30d, 1)}%`, true],
                // Days to one decimal reads "0.0d" for anything under two and a
                // half hours, which is every note in a pool that opened today.
                ['Average note age', noteAge(state.avgNoteAgeDays), false],
                ['Reserve withdrawal fn', 'None', false],
              ].map(([l, v, hi]) => (
                <div key={l as string} style={{ borderTop: '1px solid rgba(17,17,16,.2)', paddingTop: 14 }}>
                  <div className="eyebrow" style={{ fontSize: 10, letterSpacing: '.2em', marginBottom: 6 }}>{l as string}</div>
                  <div className="display tabular" style={{ fontWeight: 500, fontSize: 30, color: hi ? 'var(--accent)' : undefined }}>
                    {v as string}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
