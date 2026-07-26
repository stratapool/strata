import { TIER_COLOR } from '../lib/privacy';
import { count } from '../lib/format';
import { useCountUp } from '../lib/useCountUp';
import type { PrivacyAssessment } from '../lib/types';

/**
 * During cold start this component's job is to talk the user out of
 * withdrawing. It is not a badge. An interface that reads "protected" at an
 * anonymity set of six costs its users something real.
 */
export function PrivacyScore({ a }: { a: PrivacyAssessment }) {
  // The v2 mockup hardcoded this ring to the accent green. Keeping it tied to
  // the tier is the whole point: at fourteen notes the ring must read as an
  // alarm, not as reassurance.
  const color = TIER_COLOR[a.tier];
  const animated = useCountUp(a.score, 1300, 'score');
  const deg = Math.round(animated * 3.6);
  const alarm = a.tier === 'critical' || a.tier === 'thin';

  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 18 }}>
        Privacy score
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            width: 96,
            height: 96,
            flex: 'none',
            borderRadius: '50%',
            background: `conic-gradient(${color} ${deg}deg, var(--ink-12) ${deg}deg)`,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: 'var(--surface)',
              display: 'grid',
              placeItems: 'center',
              fontFamily: 'var(--display)',
              fontWeight: 600,
              fontSize: 26,
              fontVariantNumeric: 'tabular-nums',
              color,
            }}
          >
            {Math.round(animated)}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: 'var(--ink-70)',
          }}
        >
          <span>
            <b className="tabular">{count(a.effectiveAnonSet)}</b> notes could be
            yours
          </span>
          <span>
            <b className="tabular" style={{ color }}>
              1 in {count(a.effectiveAnonSet)}
            </b>{' '}
            indistinguishable
          </span>
          {a.suggestedWaitHours !== null && a.scoreAfterWait !== null && (
            <span style={{ color: 'var(--accent)' }}>
              Wait {a.suggestedWaitHours}h → {a.scoreAfterWait}
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          marginTop: 18,
          paddingTop: 16,
          borderTop: alarm ? `1.5px solid ${color}` : '1px solid var(--ink-12)',
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 13.5,
            marginBottom: 6,
            color: alarm ? color : 'var(--ink)',
          }}
        >
          {a.headline}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.75, color: 'var(--ink-70)' }}>
          {a.detail}
        </div>
      </div>
    </div>
  );
}
