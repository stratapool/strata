import { useEffect, useState } from 'react';
import { DotField } from './DotField';
import { count, denomLabel, eth, ethAuto, pct } from '../lib/format';
import type { PoolState } from '../lib/types';

/**
 * The Pool tab: what this contract is, stated so a stranger can check it.
 *
 * Every figure here is either read from the chain in this session or a constant
 * that can be verified against it. Where there is no data the panel says so
 * rather than drawing an empty shape — the previous version animated twelve
 * weeks of reserve history against a pool that had existed for one day.
 */

const POOL_ADDR = '0x4daA62B28c4529479785892443E0a0DFe392f460';
const VERIFIER_ADDR = '0x57254c611587343958EAbB70993b85Bc7948524F';
const MIMC_ADDR = '0x4aEE710cc6d536f2064BD1Ca194B5BB0d54Ff97f';
const EXPLORER = 'https://robinhoodchain.blockscout.com/address';
const DEPLOY_BLOCK = 20742508;

/** From the published manifest; the site serves the key under its own hash. */
const HASHES: [string, string][] = [
  ['withdraw_final.zkey', 'f2239587640574f7910630d2d4fb817a1b42e6d0b1afc674c688aab43858f753'],
  ['withdraw.wasm', 'df9bbcca32063c04f82c571238f4e9e6ef447674f1e4a4eb968b7e4c455af968'],
  ['verification_key.json', 'ccbbc843203c22552b3ac0ea2477c7b807124fc67b44a8c412e8cffc461d8d5e'],
  ['Verifier.sol', '790008aa741353707a65cd32f2f02e11a259abd0f6878473abd07cea0efa7313'],
  ['withdraw.circom', 'b6f4e710c1b0ef65e72ef09986b8060922d0cbf532da82e344e0a597450ed514'],
  ['merkleTree.circom', '1c2034409a2cc06f37d2b9286391bdc1ca7baef3a9d4cb154b4f9f0f8d59af47'],
];

function Rule({ n, title, meta }: { n: string; title: string; meta: string }) {
  return (
    <div className="section-rule">
      <span className="display" style={{ fontSize: 15, color: 'var(--accent)' }}>{n}</span>
      <span className="display section-rule-title">{title}</span>
      <span className="eyebrow section-rule-meta">{meta}</span>
    </div>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="quick"
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      style={{ fontSize: 11, letterSpacing: '.1em' }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function PoolShowcase({ state }: { state: PoolState }) {
  const [pulse, setPulse] = useState(0);
  const openTier = state.tiers.find((t) => t.open);
  const days = state.depositsPerDay;
  const maxDay = Math.max(...days, 1);

  useEffect(() => {
    setPulse((p) => p + 3);
    const id = setInterval(() => setPulse((p) => p + 1), 3400);
    return () => clearInterval(id);
  }, []);

  const reserveShare =
    state.totalEthInPool > 0
      ? (state.reserveEth / state.totalEthInPool) * 100
      : null;

  return (
    <>
      {/* ─────────────────────────────────────────────────── hero */}
      <div className="dotfield-hero" style={{ borderBottom: 'var(--rule)', position: 'relative', background: 'var(--surface)', overflow: 'hidden' }}>
        {/* Absolutely positioned, because DotField renders a bare canvas sized
            `height:100%`. Against the old fixed-height container that filled
            it; against this one, whose height comes from its content, 100%
            resolves to auto — the canvas collapses and, being in normal flow,
            sits above the hero rather than behind it. */}
        <div style={{ position: 'absolute', inset: 0 }}>
          <DotField count={state.totalUnspentNotes} pulseSignal={pulse} denomination={openTier?.value ?? 0.1} />
        </div>
        <div className="shell hero-pool">
          <div>
            <div className="eyebrow hero-pool-live">
              <span className="blink-dot" />
              Live · {denomLabel(openTier?.value ?? 0.01)} ETH pool · Robinhood Chain {state.chainId}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
              <div className="display tabular hero-pool-number">{count(state.totalUnspentNotes)}</div>
              <div style={{ paddingBottom: 14, maxWidth: 230 }}>
                <div className="display" style={{ fontSize: 25, fontWeight: 500, lineHeight: 1.22 }}>
                  unspent notes<br />in the set
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-55)', marginTop: 10 }}>
                  Each dot is one of them.
                </div>
              </div>
            </div>
            <div className="hero-pool-copy">
              Every note in here is the same size and the same shape. Withdrawing
              proves you own{' '}
              <i className="display" style={{ fontSize: 17 }}>one</i> of them without
              saying which — so the honest measure of privacy is not the balance,
              it is how many unspent notes your proof could have meant.
            </div>
          </div>

          <div className="hero-pool-facts">
            {[
              ['In pool', `${ethAuto(state.totalEthInPool)} ETH`, false],
              // Not "unique depositors". Distinct depositors are not observable
              // on chain — that is the protocol working — so this is the number
              // of deposits, which is what the value has always actually been.
              ['Deposits, all time', count(state.uniqueDepositors), false],
              ['Average note age', noteAge(state.avgNoteAgeDays), false],
              ['Reserve', `${eth(state.reserveEth, 5)} ETH`, true],
            ].map(([k, v, hi]) => (
              <div key={k as string} className="hero-pool-fact">
                <span className="eyebrow" style={{ fontSize: 10.5, letterSpacing: '.2em' }}>{k as string}</span>
                <span className="display tabular" style={{ fontSize: 24, fontWeight: 500, color: hi ? 'var(--accent)' : undefined }}>
                  {v as string}
                </span>
              </div>
            ))}
            <div style={{ fontSize: 11.5, lineHeight: 1.7, color: 'var(--ink-45)', marginTop: 14 }}>
              Read live from the chain — there is no server holding an index of
              it that you have to trust.
            </div>
          </div>
        </div>
      </div>

      {/* ────────────────────────────────────────── 01 how it works */}
      <div className="shell" style={{ paddingTop: 70 }}>
        <Rule n="01" title="How the cover works" meta="Deposit · wait · withdraw" />
        <div className="how-three">
          {[
            ['01', 'Deposit', 'You send exactly one denomination and the contract stores a commitment — Pedersen(nullifier, secret). It carries no amount and no address. Your keys are derived in your browser from a wallet signature and never leave it.'],
            ['02', 'Wait', 'Time is the part nobody can do for you. A note withdrawn minutes after it landed is linked by timing however good the proof is; a note that sat while the set grew is not. The Withdraw tab says what waiting is currently worth.'],
            ['03', 'Withdraw', 'A Groth16 proof shows you own one of the pool’s notes without revealing which, and pays out to an address that has never been linked to you. A relayer fronts the gas so that fresh address never needs funding.'],
          ].map(([n, t, b], i) => (
            <div key={n} className="how-step" style={{ animation: `rowIn .6s cubic-bezier(.2,.7,.2,1) ${i * 0.08}s both` }}>
              <div className="display" style={{ fontSize: 14, color: 'var(--accent)', marginBottom: 12 }}>{n}</div>
              <div className="display" style={{ fontSize: 27, fontWeight: 500, marginBottom: 12 }}>{t}</div>
              <div style={{ fontSize: 13, lineHeight: 1.85, color: 'var(--ink-70)' }}>{b}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─────────────────────────────────────────── 02 the set today */}
      <div className="shell" style={{ paddingTop: 70 }}>
        <Rule n="02" title="The set today" meta="Denominations · fees · activity" />
        <div className="pool-grid" style={{ marginTop: 32 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 16 }}>Denominations</div>
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
                  {/* "LOCKED" implied an on-chain threshold that unlocks. There
                      is none — each size is a separate deployment with its own
                      anonymity set, so these are labelled as a roadmap. */}
                  <span style={{ fontSize: 11, letterSpacing: '.08em', textAlign: 'right', color: t.open ? 'var(--accent)' : 'var(--ink-45)' }}>
                    {t.open ? 'LIVE' : 'PLANNED'}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--ink-55)', marginTop: 16, maxWidth: 520 }}>
              Each size is its own pool contract with its own anonymity set —
              nothing unlocks automatically. Running several at once would split
              the set between them, so a new one only launches when the live pool
              is thick enough to stand on its own. The denomination is a
              constructor argument and cannot be changed.
            </div>

            <div className="fee-three">
              {[
                ['0.30%', 'Withdrawal fee', 'Split in the contract, unchangeable.', false],
                ['0.20%', 'To the relayer', 'Fronts the gas for your fresh address.', false],
                ['0.10%', 'To the reserve', 'No function anywhere pays it out.', true],
              ].map(([v, k, b, hi]) => (
                <div key={k as string} style={{ borderTop: '1px solid rgba(17,17,16,.2)', paddingTop: 14 }}>
                  <div className="display tabular" style={{ fontWeight: 500, fontSize: 30, color: hi ? 'var(--accent)' : undefined }}>{v as string}</div>
                  <div className="eyebrow" style={{ fontSize: 10.5, letterSpacing: '.18em', marginTop: 6 }}>{k as string}</div>
                  <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--ink-55)', marginTop: 8 }}>{b as string}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
                {/* Was "reserve growth, last 12 weeks" against a pool one day
                    old: twelve empty bars, animating. Deposit timestamps are in
                    the events already being read, so this plots something that
                    happened, over however long the pool has actually existed. */}
                <span className="eyebrow">Notes added · last {days.length || 0}d</span>
                <span className="tabular" style={{ fontSize: 12, color: 'var(--accent)' }}>
                  {days.length ? `${count(days.reduce((a, b) => a + b, 0))} total` : '—'}
                </span>
              </div>
              {days.length ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 110, borderBottom: 'var(--rule)', position: 'relative', overflow: 'hidden' }}>
                    {days.map((v, i) => (
                      <div
                        key={i}
                        title={`${v} note${v === 1 ? '' : 's'}`}
                        style={{
                          flex: 1,
                          height: `${Math.max(3, (v / maxDay) * 100)}%`,
                          background: 'linear-gradient(180deg,#35d3b0,#a9e86b)',
                          transformOrigin: 'bottom',
                          animation:
                            i === days.length - 1
                              ? `barGrow .7s cubic-bezier(.2,.7,.2,1) ${i * 0.04}s both, barLive 2.4s ${0.7 + i * 0.04}s ease-in-out infinite alternate`
                              : `barGrow .7s cubic-bezier(.2,.7,.2,1) ${i * 0.04}s both`,
                        }}
                      />
                    ))}
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '34%', background: 'linear-gradient(100deg,transparent,rgba(253,253,252,.5) 50%,transparent)', animation: 'sheenX 3.2s ease-in-out infinite', pointerEvents: 'none' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10, letterSpacing: '.16em', color: 'var(--ink-45)' }}>
                    <span>{days.length}D AGO</span>
                    <span>TODAY</span>
                  </div>
                </>
              ) : (
                <div style={{ borderTop: '1px solid rgba(17,17,16,.2)', paddingTop: 14, fontSize: 12.5, lineHeight: 1.8, color: 'var(--ink-55)' }}>
                  No deposits read yet. This fills in from the chain's own
                  timestamps, so it stays empty rather than showing a shape.
                </div>
              )}
            </div>

            <div className="quad">
              {[
                // Guarding the divisor turned an empty pool into "5,000,000%".
                // Two fixed decimals then printed a real 0.002% as "0.00%".
                ['Reserve share of pool', reserveShare === null ? '—' : `${sharePct(reserveShare)}%`, false],
                ['Anonymity set, 30d', state.anonSetGrowth30d ? `+${pct(state.anonSetGrowth30d, 1)}%` : '—', true],
                ['Average note age', noteAge(state.avgNoteAgeDays), false],
                ['Reserve withdrawal fn', 'None', false],
              ].map(([l, v, hi]) => (
                <div key={l as string} style={{ borderTop: '1px solid rgba(17,17,16,.2)', paddingTop: 14 }}>
                  <div className="eyebrow" style={{ fontSize: 10, letterSpacing: '.2em', marginBottom: 6 }}>{l as string}</div>
                  <div className="display tabular" style={{ fontWeight: 500, fontSize: 30, color: hi ? 'var(--accent)' : undefined }}>{v as string}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ──────────────────────────────────────────── 03 on chain */}
      <div className="pool-dark">
        <div className="shell" style={{ paddingTop: 66, paddingBottom: 74 }}>
          <div className="section-rule section-rule-dark">
            <span className="display" style={{ fontSize: 15, color: 'var(--accent)' }}>03</span>
            <span className="display section-rule-title">Verified on chain</span>
            <span className="eyebrow section-rule-meta">Blockscout · full match</span>
          </div>

          <div className="contract-grid">
            {[
              {
                name: 'PrivacyPool',
                addr: POOL_ADDR,
                badge: 'Verified · full match',
                body: 'Holds the deposits, the merkle tree of commitments and the spent-nullifier set. Denomination, merkle depth and the fee split are constructor state and immutable.',
              },
              {
                name: 'Groth16Verifier',
                addr: VERIFIER_ADDR,
                badge: 'Verified · full match',
                body: 'Generated from the finalised proving key. Checks every withdrawal proof on chain; it is the only thing standing between a forged proof and the pool.',
              },
              {
                name: 'MiMC hasher',
                addr: MIMC_ADDR,
                badge: 'Reproducible, not verifiable',
                body: 'Has no Solidity source to verify — the deployment generates its bytecode with circomlibjs, so there is nothing for a source verifier to compile. The deployed code is a byte-for-byte substring of createCode("mimcsponge", 220), which settles the same question.',
              },
            ].map((c) => (
              <div key={c.addr} className="contract-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                  <span className="blink-dot" style={{ animation: 'none' }} />
                  <span className="eyebrow" style={{ fontSize: 10.5, color: 'var(--accent)' }}>{c.badge}</span>
                </div>
                <div className="display" style={{ fontSize: 26, fontWeight: 500, marginBottom: 12 }}>{c.name}</div>
                <div className="tabular contract-addr">{c.addr}</div>
                <div style={{ display: 'flex', gap: 10, margin: '14px 0 16px' }}>
                  <Copyable label="Copy address" value={c.addr} />
                  <a className="quick" href={`${EXPLORER}/${c.addr}#code`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, letterSpacing: '.1em', textDecoration: 'none' }}>
                    Read the code
                  </a>
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.8, opacity: 0.72 }}>{c.body}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 12.5, lineHeight: 1.8, opacity: 0.6, marginTop: 26, maxWidth: 760 }}>
            A full match means the bytecode running on chain is reproduced
            exactly by the published sources under solc 0.8.28 with the optimiser
            at 200 runs. Those settings are part of the claim: change one and the
            match fails.
          </div>
        </div>
      </div>

      {/* ───────────────────────────────────── 04 circuit and key */}
      <div className="shell" style={{ paddingTop: 70 }}>
        <Rule n="04" title="The circuit and the key" meta="Reproducible from published hashes" />
        <div className="pool-grid" style={{ marginTop: 32 }}>
          <div>
            <div style={{ fontSize: 14, lineHeight: 1.9, color: 'var(--ink-70)' }}>
              The circuit is <b style={{ fontWeight: 500, color: 'var(--ink)' }}>Tornado Cash v1’s, unchanged</b> —
              the most-audited ZK circuit in production. The only edits are the
              circom 1 → 2 syntax migration. It is deliberately not modernised:
              touching it would forfeit the assurance inherited from the most
              reviewed code of its kind.
            </div>
            <div className="fee-three">
              {[
                ['36,047', 'Non-linear constraints'],
                ['6', 'Public signals'],
                ['42', 'Private signals'],
              ].map(([v, k]) => (
                <div key={k} style={{ borderTop: '1px solid rgba(17,17,16,.2)', paddingTop: 14 }}>
                  <div className="display tabular" style={{ fontWeight: 500, fontSize: 32 }}>{v}</div>
                  <div className="eyebrow" style={{ fontSize: 10.5, letterSpacing: '.18em', marginTop: 6 }}>{k}</div>
                </div>
              ))}
            </div>
            <div className="card-hero" style={{ marginTop: 30 }}>
              <div className="eyebrow" style={{ marginBottom: 12 }}>Trusted setup · complete</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.9, color: 'var(--ink-70)' }}>
                Phase 2 closed on <b style={{ fontWeight: 500, color: 'var(--ink)' }}>six contributions</b>, each
                generating randomness in the contributor’s own browser and
                discarding it, sealed with drand round{' '}
                <b style={{ fontWeight: 500, color: 'var(--ink)' }}>6324172</b> — announced before its value
                existed, so it could not be selected for. So long as any one of
                the six destroyed their randomness, nobody can forge a proof,
                including us.
                <br />
                <br />
                Contributions are anonymous, so six entries mean six independent
                parties only if they were six different people. Nothing here
                proves that.
              </div>
            </div>
          </div>

          <div>
            <div className="eyebrow" style={{ marginBottom: 16 }}>Artefact hashes · sha256</div>
            <div style={{ borderTop: 'var(--rule)' }}>
              {HASHES.map(([k, v]) => (
                <div key={k} className="hash-row">
                  <span style={{ fontSize: 13, flex: 'none' }}>{k}</span>
                  <span className="tabular hash-value">{v}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--ink-55)', marginTop: 16 }}>
              The proving key is served from this site with the first eight hex of
              its hash in the filename, so you can check the bytes you downloaded
              against this list rather than trusting the host they came from.
            </div>
          </div>
        </div>
      </div>

      {/* ───────────────────────────────── 05 what cannot change */}
      <div className="shell" style={{ paddingTop: 70, paddingBottom: 90 }}>
        <Rule n="05" title="What cannot change" meta={`Deployed at block ${count(DEPLOY_BLOCK)}`} />
        <div className="how-three" style={{ borderBottom: 'var(--rule)' }}>
          {[
            ['No owner', 'There is no admin key, no pause, no upgrade path. Nobody can freeze a withdrawal, and nobody can rescue one either.'],
            ['No cap', 'Nothing limits what the pool can hold. If the circuit is wrong an attacker can take everything, and a forged proof is indistinguishable on chain from a real one.'],
            ['Fixed denomination', 'The commitment carries no amount, so a pool that could change its size would pay out whatever the current value is regardless of what went in.'],
          ].map(([t, b], i) => (
            <div key={t} className="how-step" style={{ animation: `rowIn .6s cubic-bezier(.2,.7,.2,1) ${i * 0.08}s both` }}>
              <div className="display" style={{ fontSize: 24, fontWeight: 500, marginBottom: 12 }}>{t}</div>
              <div style={{ fontSize: 13, lineHeight: 1.85, color: 'var(--ink-70)' }}>{b}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--ink-55)', marginTop: 20, maxWidth: 760 }}>
          No completed audit — one is being arranged. Static analysis is clean and
          there are 63 tests across four packages, but a linter cannot tell you
          whether a circuit computes the right thing and the people who wrote the
          code are the worst people to review it. Treat that as the floor.
        </div>
      </div>
    </>
  );
}

/** Adaptive precision: two fixed decimals print a real 0.002% as "0.00%". */
function sharePct(v: number): string {
  if (v === 0) return '0';
  if (v >= 1) return pct(v);
  return v.toFixed(Math.min(6, Math.max(2, Math.ceil(-Math.log10(v)) + 1)));
}

/** Days to one decimal reads "0.0d" for anything under two and a half hours. */
function noteAge(days: number): string {
  if (days <= 0) return '—';
  if (days >= 1) return `${days.toFixed(1)}d`;
  const hours = days * 24;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.max(1, Math.round(hours * 60))}m`;
}
