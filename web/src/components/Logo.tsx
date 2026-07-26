/**
 * Five strata, the middle one accented, with a single note sitting inside it.
 *
 * The mark states the product: one commitment is in there, and nothing about
 * the layer tells you which. Drawn inline rather than loaded as an image so
 * it stays crisp at 24px and costs no extra request.
 */
export function Logo({
  size = 40,
  onDark = false,
}: {
  size?: number;
  /** Flips the strata to paper so the mark works on the ink background. */
  onDark?: boolean;
}) {
  const bar = onDark ? '#efeeea' : '#111110';
  const hole = onDark ? '#111110' : '#efeeea';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 400 400"
      fill="none"
      role="img"
      aria-label="Strata"
      style={{ display: 'block', flex: 'none' }}
    >
      <g stroke={bar} strokeWidth="22" strokeLinecap="butt">
        <path d="M112 100 H288" />
        <path d="M82 150 H318" />
        <path d="M62 200 H338" />
        <path d="M82 250 H318" />
        <path d="M112 300 H288" />
      </g>
      <path d="M62 200 H338" stroke="#2fae8e" strokeWidth="22" />
      <circle cx="200" cy="200" r="11" fill={hole} />
    </svg>
  );
}

/** Mark plus wordmark, for the header. */
export function Lockup({ size = 30 }: { size?: number }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Logo size={size} />
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontWeight: 700,
          fontSize: size * 0.58,
          letterSpacing: '.24em',
          color: 'var(--ink)',
        }}
      >
        STRATA
      </span>
    </span>
  );
}
