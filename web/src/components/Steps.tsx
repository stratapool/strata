export function Steps({
  labels,
  current,
  title = 'Progress',
}: {
  labels: string[];
  /** -1 = not started; otherwise index of the in-flight step. */
  current: number;
  title?: string;
}) {
  return (
    <div className="card">
      <div className="eyebrow" style={{ marginBottom: 16 }}>
        {title}
      </div>
      {labels.map((label, i) => {
        const done = current > i;
        const active = current === i;
        const idle = current < 0;
        return (
          <div
            key={label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '11px 0',
              borderBottom: '1px solid var(--ink-12)',
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                flex: 'none',
                borderRadius: '50%',
                border: `1.5px solid ${
                  done ? 'var(--ink)' : active ? 'var(--accent)' : 'var(--ink-25)'
                }`,
                display: 'grid',
                placeItems: 'center',
                background: done ? 'var(--ink)' : 'transparent',
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                color: done
                  ? 'var(--paper)'
                  : active
                    ? 'var(--accent)'
                    : 'var(--ink-45)',
                // Proof generation takes seconds with no other feedback; the
                // pulse is the only sign the tab has not frozen.
                animation: active ? 'ringPulse 1.6s ease-out infinite' : undefined,
              }}
            >
              {i + 1}
            </span>
            <span
              style={{
                fontSize: 13,
                flex: 1,
                color: done || active ? 'var(--ink)' : 'var(--ink-45)',
              }}
            >
              {label}
            </span>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                color: done
                  ? 'var(--ink)'
                  : active
                    ? 'var(--accent)'
                    : 'rgba(17,17,16,.35)',
              }}
            >
              {done ? 'DONE' : active ? 'RUNNING' : idle ? 'IDLE' : 'QUEUED'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
