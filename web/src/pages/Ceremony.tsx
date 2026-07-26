import { useCallback, useEffect, useState } from 'react';
import { Lockup } from '../components/Logo';
import { SocialLinks, GITHUB_URL } from '../components/Social';
import { count } from '../lib/format';
import {
  attest,
  claimSlot,
  contribute,
  getStatus,
  getTranscript,
  type CeremonyStatus,
  type ContributeResult,
  type Phase,
  type Transcript,
} from '../lib/ceremony';

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

/**
 * The ceremony page.
 *
 * Two audiences with two different claims to make about them, and the copy has
 * to keep them apart. Contributors change what is true about the pool: with N
 * of them, forging a proof needs every single one to have kept their secret.
 * Verifiers confirm the transcript is intact — useful, worth rewarding, and
 * evidence of nothing whatsoever about whether anybody destroyed anything.
 *
 * Blurring that would turn a wall of green checkmarks into an argument it
 * cannot support, which on a tool holding other people's money is worse than
 * having no page.
 */
export function Ceremony() {
  const [status, setStatus] = useState<CeremonyStatus | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([getStatus(), getTranscript()]);
      setStatus(s);
      setTranscript(t);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 8000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <>
      <div style={{ borderBottom: 'var(--rule)', background: 'var(--paper)' }}>
        <div className="shell landing-nav">
          <a href="#/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
            <Lockup size={30} />
          </a>
          <div className="landing-nav-actions">
            <SocialLinks />
            <a href="#/app" style={{ textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}>
              Enter the pool
            </a>
          </div>
        </div>
      </div>

      <div className="shell-narrow page-in">
        <Header status={status} />
        {error && (
          <div style={{ border: '1.5px solid var(--alarm)', color: 'var(--alarm)', padding: '12px 14px', marginBottom: 28, fontSize: 13 }}>
            Cannot reach the ceremony: {error}
          </div>
        )}

        <div className="split" style={{ marginBottom: 56 }}>
          <Contribute status={status} onDone={refresh} />
          <Verify status={status} transcript={transcript} onDone={refresh} />
        </div>

        <Wall transcript={transcript} />
      </div>
    </>
  );
}

function Header({ status }: { status: CeremonyStatus | null }) {
  const n = status?.contributions ?? 0;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h1 className="display h-page" style={{ margin: 0, fontWeight: 600 }}>
          The ceremony <span className="star" style={{ fontSize: 30, verticalAlign: '.2em' }}>✳</span>
        </h1>
        <span className="eyebrow" style={{ letterSpacing: '.24em' }}>
          {status?.finalised ? 'finalised' : status?.slotOpen ? 'open · anyone can contribute' : 'contribution in progress'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, margin: '30px 0 10px' }}>
        <span className="display h-stat tabular" style={{ fontWeight: 500, lineHeight: 1 }}>
          {count(n)}
        </span>
        <span style={{ fontSize: 14, color: 'var(--ink-55)' }}>
          {n === 1 ? 'contribution' : 'contributions'}
        </span>
      </div>

      <p style={{ margin: '0 0 20px', maxWidth: 640, fontSize: 15, lineHeight: 1.85, color: 'var(--ink-70)' }}>
        Groth16 needs parameters derived from a secret that must be destroyed.
        Whoever can reconstruct it can forge proofs and empty the pool, and a
        forged proof is indistinguishable on chain from a real one. Each
        contribution below folds in fresh randomness and throws it away —{' '}
        <b style={{ color: 'var(--ink)' }}>
          so long as a single one of these people is telling the truth, nobody
          can forge anything
        </b>
        . That is why the number above matters, and why it is the only number on
        this page worth anything.
      </p>

      {status?.drandRound != null && (
        <p style={{ margin: '0 0 44px', maxWidth: 640, fontSize: 13, lineHeight: 1.8, color: 'var(--ink-55)' }}>
          The ceremony closes with{' '}
          <a href={`https://api.drand.sh/public/${status.drandRound}`} target="_blank" rel="noopener noreferrer">
            drand round {count(status.drandRound)}
          </a>
          , announced now rather than chosen at the end — its value does not
          exist yet, so it cannot be shopped for.
        </p>
      )}
    </>
  );
}

function Contribute({ status, onDone }: { status: CeremonyStatus | null; onDone: () => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [result, setResult] = useState<ContributeResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const busy = phase !== null;
  const canStart = !busy && status?.slotOpen === true && !status.finalised;

  const run = async () => {
    setFailure(null);
    setResult(null);
    try {
      const slot = await claimSlot({
        displayName: name.trim() || null,
        address: address.trim() || null,
      });
      const out = await contribute({
        token: slot.token,
        name: name.trim() || 'anonymous',
        userEntropy: typed,
        onPhase: (p, prog) => {
          setPhase(p);
          setProgress(prog ?? null);
        },
      });
      setResult(out);
      onDone();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setPhase(null);
      setProgress(null);
    }
  };

  if (result) {
    return (
      <div className="card-hero">
        <div className="display" style={{ fontWeight: 600, fontSize: 26, marginBottom: 12 }}>
          Contribution #{result.index} accepted
        </div>
        <p style={{ margin: '0 0 18px', fontSize: 13.5, lineHeight: 1.8, color: 'var(--ink-70)' }}>
          Your randomness is in the chain and this page never saw it. Check the
          hash below against the wall — that entry is yours, and it stays there
          whatever anyone else does afterwards.
        </p>
        <div className="hatch" style={{ border: '1px solid var(--ink-25)', padding: 14, fontSize: 11.5, wordBreak: 'break-all', fontFamily: 'var(--mono)', lineHeight: 1.7 }}>
          {result.hash}
        </div>
      </div>
    );
  }

  return (
    <div className="card-hero">
      <div className="display" style={{ fontWeight: 600, fontSize: 26, marginBottom: 12 }}>
        Contribute
      </div>
      <p style={{ margin: '0 0 22px', fontSize: 13.5, lineHeight: 1.8, color: 'var(--ink-70)' }}>
        Runs entirely in this tab: a 20 MB download, about two seconds of
        computation, a 20 MB upload. The randomness is generated here and
        discarded here — if it were produced on our side, the ceremony would
        prove nothing.
      </p>

      <Field label="Name (optional)" hint="A label on the wall. Security comes from the hashes, not from names.">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={48} disabled={busy} placeholder="anonymous" />
      </Field>
      <Field label="Address (optional)" hint="Recorded for a future airdrop. Nothing is promised by recording it; leave it blank and you simply are not on that list.">
        <input className="field" value={address} onChange={(e) => setAddress(e.target.value)} disabled={busy} placeholder="0x…" spellCheck={false} />
      </Field>
      <Field label="Type anything (optional)" hint="Mixed into your browser's randomness. Not needed, but it means you do not have to take our word for the entropy either.">
        <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} placeholder="mash the keyboard" />
      </Field>

      <button className="btn" onClick={() => void run()} disabled={!canStart} style={{ marginTop: 8, width: '100%' }}>
        {busy
          ? phase === 'downloading'
            ? progress?.total
              ? `Downloading ${mb(progress.loaded)} / ${mb(progress.total)} MB`
              : 'Downloading…'
            : phase === 'contributing'
              ? 'Contributing — do not close this tab'
              : 'Uploading…'
          : status?.finalised
            ? 'The ceremony is finalised'
            : status?.slotOpen
              ? 'Contribute'
              : 'Someone is contributing — try again shortly'}
      </button>

      {failure && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--alarm)', lineHeight: 1.7 }}>
          {failure}
        </div>
      )}

      <details style={{ marginTop: 20, fontSize: 12.5, color: 'var(--ink-55)' }}>
        <summary style={{ cursor: 'pointer' }}>Prefer a terminal?</summary>
        <p style={{ lineHeight: 1.8, margin: '10px 0 0' }}>
          Contribute from your own machine and upload the result. Same endpoint,
          same checks — claim a slot first to get a token.
        </p>
        <pre style={{ margin: '10px 0 0', padding: '12px 14px', background: 'var(--paper)', border: '1px solid var(--ink-12)', fontSize: 11, lineHeight: 1.7, overflowX: 'auto', fontFamily: 'var(--mono)' }}>
{`TOKEN=$(curl -sX POST https://stratapool.xyz/ceremony/slot \\
  -H 'content-type: application/json' -d '{}' | jq -r .token)

curl -so current.zkey https://stratapool.xyz/ceremony/zkey
snarkjs zkey contribute current.zkey mine.zkey -n="your name" -e="$(head -c32 /dev/urandom | xxd -p)"

curl -X POST "https://stratapool.xyz/ceremony/contribute?token=$TOKEN" \\
  -H 'content-type: application/octet-stream' --data-binary @mine.zkey`}
        </pre>
      </details>
    </div>
  );
}

function Verify({
  status,
  transcript,
  onDone,
}: {
  status: CeremonyStatus | null;
  transcript: Transcript | null;
  onDone: () => void;
}) {
  const [handle, setHandle] = useState('');
  const [address, setAddress] = useState('');
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = transcript?.contributions.at(-1)?.zkeySha256 ?? null;

  const send = async () => {
    setFailure(null);
    try {
      if (!latest) throw new Error('nothing has been contributed yet');
      await attest({ handle: handle.trim() || null, address: address.trim() || null, zkeySha256: latest });
      setSent(true);
      onDone();
    } catch (e) {
      setFailure((e as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 14 }}>Verify</div>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, lineHeight: 1.8, color: 'var(--ink-70)' }}>
        Anyone can check that the chain is intact and that every contribution on
        the wall is really in it. This is worth doing and worth rewarding — but
        be clear about what it shows:{' '}
        <b style={{ color: 'var(--ink)' }}>
          verification cannot tell you whether anyone destroyed their secret
        </b>
        . Only contributing changes that.
      </p>
      <pre style={{ margin: '0 0 14px', padding: '12px 14px', background: 'var(--paper)', border: '1px solid var(--ink-12)', fontSize: 11, lineHeight: 1.7, overflowX: 'auto', fontFamily: 'var(--mono)' }}>
{`curl -so current.zkey https://stratapool.xyz/ceremony/zkey
sha256sum current.zkey
snarkjs zkey verify withdraw.r1cs pot16_final.ptau current.zkey`}
      </pre>
      {latest && (
        <div style={{ fontSize: 11.5, color: 'var(--ink-55)', lineHeight: 1.7, marginBottom: 16, wordBreak: 'break-all' }}>
          Current key: <b className="tabular" style={{ color: 'var(--ink)' }}>{latest}</b>
        </div>
      )}

      {sent ? (
        <div style={{ fontSize: 12.5, color: 'var(--accent)', lineHeight: 1.7 }}>
          Recorded against {status?.contributions ?? 0} contributions.
        </div>
      ) : (
        <>
          <Field label="Handle (optional)" hint="">
            <input className="field" value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={48} placeholder="anonymous" />
          </Field>
          <Field label="Address (optional)" hint="">
            <input className="field" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} />
          </Field>
          <button className="btn-ghost" onClick={() => void send()} disabled={!latest} style={{ width: '100%' }}>
            I verified this key
          </button>
          {failure && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--alarm)', lineHeight: 1.7 }}>{failure}</div>
          )}
        </>
      )}
    </div>
  );
}

function Wall({ transcript }: { transcript: Transcript | null }) {
  const rows = transcript?.contributions ?? [];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 10 }}>
        <h2 className="display" style={{ margin: 0, fontWeight: 600, fontSize: 30 }}>
          Contributors
        </h2>
        <a href={`${GITHUB_URL}#the-ceremony`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5 }}>
          How to check this list →
        </a>
      </div>
      <p style={{ margin: '0 0 26px', fontSize: 13, color: 'var(--ink-55)', lineHeight: 1.8, maxWidth: 620 }}>
        Names are labels; the hashes are the record. Each one is baked into the
        key itself, so a contribution cannot be removed from this chain without
        every later one breaking.
      </p>

      {rows.length === 0 ? (
        <div style={{ border: '1px dashed var(--ink-25)', padding: '34px 20px', textAlign: 'center', fontSize: 13.5, color: 'var(--ink-55)' }}>
          Nobody has contributed yet. The first entry is the one that makes this
          worth anything at all.
        </div>
      ) : (
        rows.map((c) => (
          <div
            key={c.index}
            style={{
              display: 'grid',
              gridTemplateColumns: '54px minmax(0, 1fr) minmax(0, 2fr)',
              gap: 14,
              alignItems: 'baseline',
              padding: '13px 0',
              borderTop: '1px solid var(--ink-12)',
              fontSize: 13,
            }}
          >
            <span className="tabular" style={{ color: 'var(--ink-45)' }}>#{c.index}</span>
            <span style={{ fontWeight: 500, wordBreak: 'break-word' }}>
              {c.displayName || c.name || 'anonymous'}
            </span>
            <span
              className="tabular"
              style={{ color: 'var(--ink-55)', fontSize: 11.5, wordBreak: 'break-all', fontFamily: 'var(--mono)' }}
            >
              {c.hash.slice(0, 32)}…
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && (
        <div style={{ fontSize: 11.5, color: 'var(--ink-45)', lineHeight: 1.65, marginTop: 5 }}>{hint}</div>
      )}
    </div>
  );
}
