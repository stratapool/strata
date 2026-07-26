import { useEffect, useRef, useState } from 'react';
import { chainConfig, usePool } from '../lib/usePool';
import { Lockup } from '../components/Logo';
import { SocialLinks, X_URL, GITHUB_URL } from '../components/Social';
import { count, eth, ethAuto } from '../lib/format';

/**
 * A different address on every load.
 *
 * The card illustrates "an on-chain identity you cannot link back" — a fixed
 * string read as one particular account, which is the opposite of the point.
 * Regenerating says what the product does: every withdrawal lands somewhere
 * that has never been used before.
 *
 * crypto rather than Math.random. It is only decoration, but shipping an
 * address-shaped string from a weak source on a privacy tool invites exactly
 * the question you do not want asked about the rest of the codebase.
 */
function randomAddressStub(): string {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `0x${hex.slice(0, 2)}…${hex.slice(2, 6)}`;
}

const TICKER = [
  'just now · anonymous deposit 0.1 ETH',
  '2m ago · 0.0002 ETH into reserve',
  '4m ago · anonymous deposit 0.1 ETH ×3',
  '7m ago · note handed off · no on-chain trace',
  '11m ago · anonymous deposit 0.1 ETH ×2',
  '12m ago · 0.0009 ETH into reserve',
  '15m ago · proof verified · 0.0997 ETH withdrawn',
  '18m ago · anonymous deposit 0.1 ETH',
];

function useParallax() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const mx = e.clientX / window.innerWidth - 0.5;
      const my = e.clientY / window.innerHeight - 0.5;
      const host = ref.current;
      if (!host) return;
      host.querySelectorAll<HTMLElement>('[data-depth]').forEach((el) => {
        const d = Number(el.dataset.depth ?? 0);
        el.style.translate = `${-mx * d}px ${-my * d}px`;
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);
  return ref;
}

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => entry?.isIntersecting && setShown(true),
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(20px)',
        transition: `opacity .7s cubic-bezier(.2,.7,.2,1) ${delay}s, transform .7s cubic-bezier(.2,.7,.2,1) ${delay}s`,
      }}
    >
      {children}
    </div>
  );
}

export function Landing() {
  const heroRef = useParallax();
  const { state } = usePool();
  // Once per mount, not per render: it should read as a fresh address, not
  // as a slot machine reacting to every pool tick.
  const [stubAddress] = useState(randomAddressStub);
  // Undefined until the first chain read returns: against a live pool the
  // denomination comes from the contract, so nothing is open on the first
  // frame. Asserting non-null here blanked the whole page in production
  // while the mock — which always has a tier open — showed nothing wrong.
  const openTier = state.tiers.find((t) => t.open);
  const nextTier = state.tiers.find((t) => !t.open);

  return (
    <>
      {/* ---------- nav ---------- */}
      <div className="shell landing-nav">
        <a href="#/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
          <Lockup size={32} />
        </a>
        <div className="landing-nav-links">
          <a href="#how" style={{ textDecoration: 'none' }}>How it works</a>
          <a href="#fees" style={{ textDecoration: 'none' }}>Fees</a>
          <a href="#pool" style={{ textDecoration: 'none' }}>Pool</a>
          <a href="#/ceremony" style={{ textDecoration: 'none' }}>Ceremony</a>
          <a href="#docs" style={{ textDecoration: 'none' }}>Docs</a>
        </div>
        <div className="landing-nav-actions">
          <SocialLinks />
          <a href="#/app" style={{ textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}>
            Connect wallet
          </a>
        </div>
      </div>

      {/* ---------- hero ---------- */}
      <div
        ref={heroRef}
        className="shell hero-grid band"
        style={{ position: 'relative', '--pt': '64px', '--pb': '110px' } as React.CSSProperties}
      >
        <div>
          <div
            className="eyebrow"
            style={{ animation: 'heroIn .8s cubic-bezier(.2,.7,.2,1) both .05s', marginBottom: 34 }}
          >
            Privacy for everyone · Chain 4663
          </div>
          <h1
            className="display h-hero"
            style={{
              animation: 'heroIn .9s cubic-bezier(.2,.7,.2,1) both .18s',
              margin: '0 0 42px',
              fontWeight: 600,
              lineHeight: 1.08,
            }}
          >
            Bury every transfer
            <br />
            in <em style={{ fontStyle: 'italic' }}>ten thousand</em> others{' '}
            <span className="star" style={{ fontSize: 52, verticalAlign: '.12em' }}>✳</span>
          </h1>
          <div
            className="hero-cta"
            style={{ animation: 'heroIn .9s cubic-bezier(.2,.7,.2,1) both .32s' }}
          >
            <div>
              <div className="display" style={{ fontWeight: 500, fontSize: 58, lineHeight: 1 }}>
                0.3<span style={{ fontSize: 30, verticalAlign: '.5em' }}>%</span>
              </div>
              <div className="eyebrow" style={{ marginTop: 8, letterSpacing: '.22em' }}>
                Withdraw fee · 0.1% back to pool
              </div>
            </div>
            <a href="#/app" className="btn-ghost">Enter the pool</a>
            <a href="#how" style={{ fontSize: 14, color: 'var(--ink-70)' }}>
              How it hides you →
            </a>
          </div>
        </div>

        <div className="hero-art" style={{ position: 'relative', height: 560 }}>
          <div data-depth="10" style={{ position: 'absolute', left: '8%', top: '14%', width: 390, height: 330 }}>
            <div
              style={{
                width: '100%',
                height: '100%',
                background:
                  'radial-gradient(closest-side,#111110 40%,rgba(17,17,16,.75) 62%,transparent 72%)',
                filter: 'blur(2px)',
                animation: 'blobBreath 9s ease-in-out infinite',
              }}
            />
          </div>
          <div
            data-depth="22"
            style={{ position: 'absolute', left: '2%', top: '6%', width: 230, height: 230, animation: 'discFloat 8s ease-in-out infinite' }}
          >
            <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: 'var(--rule)', transform: 'translate(14px,10px) scaleY(.92)' }} />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                background: 'linear-gradient(135deg,#35d3b0 12%,#a9e86b 58%,#f0ee5a 92%)',
                transform: 'scaleY(.92)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: '-30%',
                  background:
                    'conic-gradient(from 0deg,transparent 0 70%,rgba(255,255,255,.55) 82%,transparent 94%)',
                  animation: 'sheenSpin 7s linear infinite',
                }}
              />
            </div>
          </div>
          <div
            data-depth="16"
            style={{ position: 'absolute', right: '2%', top: '8%', width: 250, background: 'var(--surface)', border: 'var(--rule)' }}
          >
            <div style={{ position: 'absolute', top: -13, left: -1.5, width: 96, height: 13, background: 'var(--surface)', border: 'var(--rule)', borderBottom: 0 }} />
            <div style={{ position: 'absolute', top: 9, right: 12, letterSpacing: '.3em', fontSize: 11 }}>***</div>
            <div style={{ padding: '30px 24px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
              <div
                style={{
                  width: 150,
                  height: 130,
                  background: 'repeating-linear-gradient(0deg,#fdfdfc 0 6px,rgba(17,17,16,.08) 6px 8px)',
                  border: '1px solid var(--ink-25)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 52,
                  color: 'var(--ink-25)',
                }}
              >
                ◎
              </div>
              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '.04em' }}>{stubAddress}</div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-55)', marginTop: 3 }}>on-chain identity · unlinkable</div>
              </div>
            </div>
          </div>
          <div data-depth="30" style={{ position: 'absolute', left: '24%', bottom: '16%', width: 104, height: 104, background: 'var(--surface)', border: 'var(--rule)', display: 'grid', placeItems: 'center', fontSize: 36 }}>
            ⛶
          </div>
          <div
            data-depth="36"
            style={{
              position: 'absolute',
              right: '8%',
              bottom: '20%',
              width: 74,
              height: 88,
              background: 'linear-gradient(160deg,#35d3b0,#f0ee5a)',
              clipPath: 'polygon(50% 0,100% 100%,0 100%)',
              animation: 'coneFloat 7s ease-in-out infinite',
            }}
          />
        </div>
      </div>

      {/* ---------- ticker ---------- */}
      <div style={{ borderTop: 'var(--rule)', borderBottom: '1px solid rgba(17,17,16,.18)', background: 'var(--surface)', overflow: 'hidden', padding: '13px 0' }}>
        <div style={{ display: 'flex', width: 'max-content', animation: 'marquee 34s linear infinite' }}>
          {[0, 1].map((dup) => (
            <div key={dup} style={{ display: 'flex', gap: 48, paddingRight: 48 }}>
              {TICKER.map((t) => (
                <span
                  key={t}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontSize: 12.5, letterSpacing: '.12em', color: 'var(--ink-70)', whiteSpace: 'nowrap' }}
                >
                  <span style={{ fontSize: 9, color: 'var(--accent)' }}>✳</span>
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ---------- unlinkable band ---------- */}
      <div style={{ borderTop: 'var(--rule)', borderBottom: 'var(--rule)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10,1fr)' }}>
          <div style={{ borderRight: '1px solid rgba(17,17,16,.18)' }} />
          <div style={{ gridColumn: 'span 3', borderRight: '1px solid rgba(17,17,16,.18)', padding: '44px 36px' }}>
            <div className="display" style={{ fontWeight: 600, fontSize: 34, lineHeight: 1.25 }}>
              Unlinkable
              <br />
              by design
            </div>
          </div>
          <div style={{ gridColumn: 'span 4', borderRight: '1px solid rgba(17,17,16,.18)', padding: '44px 40px', display: 'flex', alignItems: 'center' }}>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.9, color: 'var(--ink-70)', textAlign: 'center' }}>
              Deposits are split into fixed-denomination notes, identical to every
              other note in the pool. Withdrawing proves only that you own one of
              them — never which one. Between the receiving address and where the
              money came from, no on-chain link exists.
            </p>
          </div>
          <div style={{ borderRight: '1px solid rgba(17,17,16,.18)' }} />
          <div style={{ display: 'grid', placeItems: 'center', background: 'var(--surface)', borderLeft: 'var(--rule)', minHeight: 120, fontSize: 34 }}>
            ⚿
          </div>
        </div>
      </div>

      {/* ---------- how ---------- */}
      <div id="how" className="shell band" style={{ '--pt': '130px', '--pb': '120px' } as React.CSSProperties}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 74 }}>
          <h2 className="display h-section" style={{ margin: 0, fontWeight: 600 }}>
            Three steps to vanish <span className="star" style={{ fontSize: 32, verticalAlign: '.2em' }}>✳</span>
          </h2>
          <span className="eyebrow" style={{ letterSpacing: '.28em' }}>How it hides you</span>
        </div>
        <div className="how-grid">
          {[
            {
              n: '01',
              t: 'Deposit, auto-split',
              b: 'Your deposit becomes identical fixed-denomination notes. Same shape, same size — the amount stops being a fingerprint. Keys derive from your wallet signature. Non-custodial.',
            },
            {
              n: '02',
              t: 'Blend into the set',
              b: 'Your notes land among every other unspent note at that denomination. The longer they sit, the more deposits land behind yours, and the weaker the timing signal gets.',
            },
            {
              n: '03',
              t: 'Withdraw, no trail',
              b: 'A zero-knowledge proof verifies ownership, a nullifier prevents double-spend. Funds land on a fresh address with no on-chain link to where you deposited.',
            },
          ].map((s, i) => (
            <Reveal key={s.n} delay={i * 0.12}>
              <div style={{ padding: i === 0 ? '40px 40px 12px 0' : '40px 40px 12px 40px', borderRight: i < 2 ? '1px solid rgba(17,17,16,.18)' : undefined }}>
                <div className="display" style={{ fontSize: 70, fontWeight: 500, lineHeight: 1, marginBottom: 22 }}>{s.n}</div>
                <div style={{ fontWeight: 700, fontSize: 19, marginBottom: 12 }}>{s.t}</div>
                <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.85, color: 'var(--ink-70)' }}>{s.b}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      {/* ---------- fees ---------- */}
      <div id="fees" style={{ borderTop: 'var(--rule)', background: 'var(--surface)' }}>
        <div className="shell fee-grid band" style={{ '--pt': '120px', '--pb': '120px' } as React.CSSProperties}>
          <div>
            <span className="eyebrow" style={{ letterSpacing: '.28em' }}>The fee is the moat</span>
            <div className="display h-fee" style={{ marginTop: 20, fontWeight: 500, lineHeight: 0.95 }}>
              0.3<span style={{ fontSize: 100 }}>%</span>
            </div>
            <div className="display" style={{ marginTop: 16, fontWeight: 600, fontSize: 32 }}>
              Hardcoded. Unchangeable.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.9, color: 'var(--ink-70)' }}>
              0.2% goes to the relayer that fronts your gas — without it, you would
              have to fund your fresh address first, and that transfer would link it
              to you permanently. 0.1% stays in the pool reserve, which the contract
              has no function to withdraw from. The split is written into the
              contract and cannot be changed.
            </p>
            <div>
              <div style={{ display: 'flex', height: 14, border: 'var(--rule)', overflow: 'hidden' }}>
                <div style={{ width: '99.7%', background: 'repeating-linear-gradient(-45deg,#fdfdfc 0 7px,rgba(17,17,16,.12) 7px 9px)' }} />
                <div style={{ width: '0.2%', minWidth: 8, background: '#35d3b0' }} />
                <div style={{ width: '0.1%', minWidth: 8, background: '#f0ee5a' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 11.5, letterSpacing: '.14em', color: 'var(--ink-55)' }}>
                <span>99.7% to your new address</span>
                <span>0.2% relayer · 0.1% reserve</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 40, borderTop: '1px solid rgba(17,17,16,.18)', paddingTop: 24 }}>
              {[
                ['No gas required', 'The relayer fronts it, so your fresh address can start empty.'],
                ['Reserve only grows', 'That 0.1% has no withdrawal function. Nobody can take it out.'],
                ['Safer the more it is used', 'fees → will reward long-term holders → bigger set → more people'],
              ].map(([t, b]) => (
                <div key={t}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{t}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--ink-55)' }}>{b}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ---------- pool stats ---------- */}
      <div id="pool" style={{ background: 'var(--ink)', color: 'var(--paper)' }}>
        <div className="shell band" style={{ '--pt': '110px', '--pb': '110px' } as React.CSSProperties}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 70 }}>
            <h2 className="display h-section" style={{ margin: 0, fontWeight: 600 }}>
              The anonymity set only grows
            </h2>
            <span className="eyebrow" style={{ letterSpacing: '.28em', color: 'rgba(239,238,234,.45)' }}>
              Pool status · live
            </span>
          </div>
          <div className="stats-grid">
            {[
              [ethAuto(state.totalEthInPool), 'ETH in pool', false],
              [count(state.totalUnspentNotes), 'unspent notes · anonymity set', true],
              [eth(state.reserveEth, 4), 'ETH in reserve · no withdrawal function', false],
              [count(state.uniqueDepositors), 'unique depositors', false],
            ].map(([v, l, hi]) => (
              <div key={l as string} style={{ borderTop: '1px solid rgba(239,238,234,.3)', paddingTop: 24 }}>
                <div
                  className="display h-stat"
                  style={{
                    fontWeight: 500,
                    lineHeight: 1,
                    ...(hi
                      ? {
                          background: 'linear-gradient(92deg,#35d3b0,#f0ee5a)',
                          WebkitBackgroundClip: 'text',
                          backgroundClip: 'text',
                          color: 'transparent',
                        }
                      : {}),
                  }}
                >
                  {v as string}
                </div>
                <div style={{ marginTop: 12, fontSize: 13, color: 'rgba(239,238,234,.55)' }}>{l as string}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 70, display: 'flex', gap: 14, alignItems: 'center', fontSize: 13, color: 'rgba(239,238,234,.5)' }}>
            <span style={{ color: '#35d3b0' }}>⚿</span>
            No owner · no upgrade · no pause
            {openTier && ` · fixed denomination ${openTier.value} ETH`}
            {openTier &&
              nextTier &&
              ` · ${nextTier.value} unlocks at ${count(nextTier.unlockThreshold)} notes`}
          </div>
        </div>
      </div>

      {/* ---------- docs ---------- */}
      {/* The nav has always linked here; until now there was no #docs to land
          on. What belongs at that anchor on a privacy tool is not a feature
          tour — it is everything a visitor needs to check the deployment
          without believing a word of the rest of the page. */}
      <div id="docs" className="shell band" style={{ '--pt': '120px', '--pb': '110px' } as React.CSSProperties}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <h2 className="display h-section" style={{ margin: 0, fontWeight: 600 }}>
            Check it yourself <span className="star" style={{ fontSize: 30, verticalAlign: '.2em' }}>✳</span>
          </h2>
          <span className="eyebrow" style={{ letterSpacing: '.28em' }}>Docs</span>
        </div>
        <p style={{ margin: '0 0 44px', fontSize: 15, lineHeight: 1.8, color: 'var(--ink-70)', maxWidth: 620 }}>
          Every claim on this page is checkable from a terminal. Nothing below
          asks you to trust the host it came from — the proving key is verified
          against a hash published in the repository, and the contracts hold no
          owner, no upgrade path and no pause.
        </p>
        <DocsFacts />
      </div>

      {/* ---------- cta ---------- */}
      <div className="shell band" style={{ '--pt': '150px', '--pb': '50px', textAlign: 'center' } as React.CSSProperties}>
        <div className="display h-cta" style={{ fontWeight: 600, lineHeight: 1.15, marginBottom: 26 }}>
          Put it in.
          <br />
          Forget it is there. <span className="star" style={{ fontSize: 42, verticalAlign: '.15em' }}>✳</span>
        </div>
        <p style={{ margin: '0 0 48px', fontSize: 15, color: 'var(--ink-55)' }}>
          The thicker the set and the longer you wait, the harder you are to trace.
        </p>
        <a href="#/app" className="btn-ghost">Enter the pool</a>
        <div style={{ marginTop: 130, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: 'var(--rule)', paddingTop: 24, fontSize: 11.5, letterSpacing: '.18em', color: 'var(--ink-55)' }}>
          <span>STRATA · PRIVACY POOL</span>
          <span>ROBINHOOD CHAIN 4663 · ETH</span>
          <span style={{ display: 'flex', gap: 20 }}>
            <a href={X_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ink-55)', textDecoration: 'none' }}>
              X
            </a>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ink-55)', textDecoration: 'none' }}>
              GITHUB
            </a>
            {/* No AUDIT link: there is no audit, and a dead link where one
                would go is exactly the wrong kind of signalling. */}
          </span>
        </div>
      </div>
    </>
  );
}

/**
 * The deployment, as facts a reader can act on.
 *
 * Read from the same config the client itself uses rather than written down:
 * this page has already shipped a pool address once that a redeployment left
 * stale, and a documentation page that quietly lies about which contract holds
 * the money is worse than no page.
 */
function DocsFacts() {
  const cfg = chainConfig();
  const zkeyName = (cfg?.proverAssets.zkey ?? '').split('/').pop() ?? '';
  // withdraw_final.<sha8>.zkey — the name is the first 8 hex of its SHA-256,
  // which is what makes the check below self-maintaining across a key change.
  const zkeySha8 = /\.([0-9a-f]{8})\.zkey$/.exec(zkeyName)?.[1] ?? null;

  const rows: [string, string][] = [
    ['Pool contract', cfg?.poolAddress ?? 'simulated — no contract'],
    ['Chain', cfg ? `Robinhood Chain · ${cfg.chainId}` : '—'],
    ['Circuit', "Tornado Cash v1's, unchanged but for circom 1 → 2 syntax"],
    ['Proving key', zkeyName || '—'],
    ['Trusted setup', 'phase 1 from the Perpetual Powers of Tau; phase 2 is open — see Ceremony'],
    ['Audit', 'none completed — one is being arranged'],
  ];

  return (
    <div className="split">
      <div>
        {rows.map(([k, v]) => (
          <div
            key={k}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 20,
              padding: '13px 0',
              borderTop: '1px solid var(--ink-12)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            <span style={{ color: 'var(--ink-55)', flex: 'none' }}>{k}</span>
            <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="eyebrow" style={{ marginBottom: 14 }}>Verify the proving key</div>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, lineHeight: 1.75, color: 'var(--ink-70)' }}>
          Your browser downloads this file to build a withdrawal proof. The
          filename carries the first eight hex of its SHA-256, so a substituted
          key fails the check below — you do not have to trust this server.
        </p>
        <pre
          style={{
            margin: 0,
            padding: '12px 14px',
            background: 'var(--paper)',
            border: '1px solid var(--ink-12)',
            fontSize: 11.5,
            lineHeight: 1.7,
            overflowX: 'auto',
            fontFamily: 'var(--mono)',
          }}
        >
{`curl -sO https://stratapool.xyz/circuit/${zkeyName}
sha256sum ${zkeyName}`}
        </pre>
        {zkeySha8 && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ink-55)', lineHeight: 1.7 }}>
            It must begin <b className="tabular" style={{ color: 'var(--ink)' }}>{zkeySha8}</b>. The
            full hash is in the README, next to the hashes of the circuit and
            the generated verifier.
          </div>
        )}
        <div style={{ display: 'flex', gap: 20, marginTop: 18, flexWrap: 'wrap' }}>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 500 }}>
            Read the source →
          </a>
          <a href="#/ceremony" style={{ fontSize: 13, fontWeight: 500 }}>
            Contribute to the ceremony →
          </a>
        </div>
      </div>
    </div>
  );
}
