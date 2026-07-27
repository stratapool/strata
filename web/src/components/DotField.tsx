import { useEffect, useRef } from 'react';

/**
 * Ceiling on queued arrival animations.
 *
 * Small on purpose: this is decoration for deposits happening now, and more
 * than a handful in flight reads as a glitch rather than as activity. It is
 * also the backstop for any future path that queues while nothing is drawing.
 */
const MAX_SPARKS = 12;

interface Point {
  x: number;
  y: number;
  ph: number;
  br: boolean;
  s: number;
}

interface Spark {
  x: number;
  y: number;
  tx: number;
  ty: number;
  t: number;
  label: string;
  trail: { x: number; y: number }[];
}

interface Ripple {
  x: number;
  y: number;
  t: number;
}

/**
 * The anonymity set, drawn honestly: one dot per *unspent* note.
 *
 * Not per deposit ever made — spent notes provide no cover, and counting them
 * would inflate the only number on this site that actually measures privacy.
 *
 * Incoming deposits fall in labelled, trail briefly, then land and become
 * indistinguishable from everything already there. That landing is the whole
 * product in one gesture, which is why it plays continuously rather than
 * waiting behind a button.
 */
export function DotField({
  count,
  pulseSignal,
  denomination,
}: {
  count: number;
  /** Increment to send deposits flying in and settling into the field. */
  pulseSignal: number;
  /** Drives the labels, so they can only show amounts the pool accepts. */
  denomination: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const countRef = useRef(count);
  const denomRef = useRef(denomination);
  const sparks = useRef<Spark[]>([]);
  const ripples = useRef<Ripple[]>([]);
  const pts = useRef<Point[] | null>(null);
  const dims = useRef({ w: 0, h: 0 });
  const mouse = useRef({ x: -9999, y: -9999 });
  const lastPulse = useRef(pulseSignal);

  countRef.current = count;
  denomRef.current = denomination;

  // A tab that has been away is not owed the animations it missed. Anything
  // still queued when it returns is stale by definition — the deposits it
  // depicts landed minutes ago — and playing it is what produced the burst.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) sparks.current.length = 0;
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (pulseSignal === lastPulse.current) return;
    const n = pulseSignal - lastPulse.current;
    lastPulse.current = pulseSignal;

    // Nothing is spawned while the tab is hidden.
    //
    // requestAnimationFrame does not run there, so sparks were queued and never
    // consumed: the fifteen-second poll kept moving pulseSignal, each move added
    // up to four, and none of them advanced. Returning to a tab left open for a
    // while replayed the whole backlog at once — a wall of particles, each one
    // also depositing a permanent dot into the field as it landed.
    if (typeof document !== 'undefined' && document.hidden) return;

    // Labels are generated from the live denomination rather than a fixed
    // list: the mockup hardcoded "+1 ETH", which would advertise an amount
    // the pool does not accept while only the 0.1 tier is open.
    const d = denomRef.current;
    const label = () => {
      const multiple = 1 + Math.floor(Math.random() * 3);
      return multiple === 1 ? `+${d} ETH` : `+${d} ETH ×${multiple}`;
    };

    // Bounded twice: per signal, and in total. The per-signal cap alone let a
    // slow tab accumulate an unbounded queue.
    const room = Math.max(0, MAX_SPARKS - sparks.current.length);
    for (let i = 0; i < Math.min(n, 4, room); i++) {
      sparks.current.push({
        x: 0.08 + Math.random() * 0.84,
        y: -0.08,
        tx: 0.05 + Math.random() * 0.9,
        ty: 0.15 + Math.random() * 0.7,
        // Negative start staggers a burst so they do not fall in lockstep.
        t: -i * 0.25,
        label: label(),
        trail: [],
      });
    }
  }, [pulseSignal]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const onMove = (e: MouseEvent) => {
      mouse.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onMove);

    let raf = 0;
    // Drawing 12k dots costs more than it communicates; past this we sample
    // and the caption carries the real number.
    const MAX_DOTS = 900;
    const TRAIL = 14;
    const REPEL_RADIUS = 120;

    const initPts = (w: number, h: number) => {
      const n = Math.min(MAX_DOTS, Math.max(1, countRef.current));
      const aspect = w / Math.max(1, h);
      const cols = Math.max(2, Math.round(Math.sqrt(n * aspect)));
      const rows = Math.max(2, Math.ceil(n / cols));

      // The field grows with the set instead of always filling the canvas.
      //
      // Spreading fifty notes evenly over a 1900px canvas put them seventeen
      // across and three down, which reads as an empty page rather than as a
      // small pool — understating the set, not flattering it. Occupying a
      // centred region proportional to the count means a handful looks like a
      // handful and a thousand fills the frame, which is the comparison the
      // picture is for.
      const fill = Math.min(1, 0.3 + 0.7 * Math.sqrt(n / 600));
      const lo = (1 - fill) / 2;

      // Fewer notes, larger dots. At the low end each one is a visible object;
      // at the high end they have to be small or the field turns into a solid
      // block and stops conveying a count at all.
      const scale = Math.max(1, 2.4 - n / 300);

      const out: Point[] = [];
      for (let r = 0; r < rows && out.length < n; r++) {
        for (let c = 0; c < cols && out.length < n; c++) {
          const gx = (c + 0.5) / cols + ((Math.random() - 0.5) * 0.55) / cols;
          const gy = (r + 0.5) / rows + ((Math.random() - 0.5) * 0.75) / rows;
          out.push({
            x: lo + gx * fill,
            y: lo + gy * fill,
            ph: Math.random() * 6.2832,
            br: Math.random() < 0.08,
            s: (0.8 + Math.random() * 0.7) * scale,
          });
        }
      }
      pts.current = out;
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = performance.now();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (!cw || !ch) return;

      const target = Math.min(MAX_DOTS, Math.max(1, countRef.current));
      if (dims.current.w !== cw || dims.current.h !== ch) {
        dims.current = { w: cw, h: ch };
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        initPts(cw, ch);
      } else if (pts.current && Math.abs(pts.current.length - target) > 24) {
        initPts(cw, ch);
      }
      if (!pts.current) initPts(cw, ch);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      const rect = canvas.getBoundingClientRect();
      const mx = mouse.current.x - rect.left;
      const my = mouse.current.y - rect.top;

      for (const p of pts.current!) {
        let x = (p.x + Math.sin(t * 0.00022 + p.ph) * 0.0035) * cw;
        let y = (p.y + Math.cos(t * 0.00017 + p.ph * 1.7) * 0.0035) * ch;

        // Dots retreat from the cursor, so the set reads as a substance
        // rather than a static texture.
        const dx = x - mx;
        const dy = y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < REPEL_RADIUS * REPEL_RADIUS && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = (1 - d / REPEL_RADIUS) * 30;
          x += (dx / d) * push;
          y += (dy / d) * push;
        }

        const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.0007 + p.ph * 3));
        if (p.br) {
          ctx.fillStyle = `rgba(47,174,142,${(0.8 * tw * 0.9).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, 1.7 * p.s, 0, 6.2832);
          ctx.fill();
        } else {
          ctx.fillStyle = `rgba(17,17,16,${(0.8 * tw * 0.4).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, 1.15 * p.s, 0, 6.2832);
          ctx.fill();
        }
      }

      for (let i = sparks.current.length - 1; i >= 0; i--) {
        const s = sparks.current[i]!;
        s.t += 0.011;
        if (s.t < 0) continue;

        if (s.t >= 1) {
          sparks.current.splice(i, 1);
          // It joins the field as an ordinary dot — no highlight, no marker.
          pts.current!.push({
            x: s.tx,
            y: s.ty,
            ph: Math.random() * 6.28,
            br: false,
            s: 1,
          });
          ripples.current.push({ x: s.tx, y: s.ty, t: 0 });
          ripples.current.push({ x: s.tx, y: s.ty, t: -0.18 });
          continue;
        }

        const ee = s.t * s.t * (3 - 2 * s.t);
        const x = (s.x + (s.tx - s.x) * ee) * cw;
        const y = (s.y + (s.ty - s.y) * ee) * ch + Math.sin(s.t * 9) * 3;

        s.trail.unshift({ x, y });
        if (s.trail.length > TRAIL) s.trail.pop();
        s.trail.forEach((p, j) => {
          const a = (1 - j / TRAIL) * 0.5;
          ctx.fillStyle = `rgba(47,174,142,${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (1 - j / TRAIL) * 3.2, 0, 6.2832);
          ctx.fill();
        });

        const grd = ctx.createRadialGradient(x, y, 0, x, y, 16);
        grd.addColorStop(0, 'rgba(47,174,142,.55)');
        grd.addColorStop(1, 'rgba(47,174,142,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, 6.2832);
        ctx.fill();

        ctx.fillStyle = 'rgba(17,17,16,.95)';
        ctx.beginPath();
        ctx.arc(x, y, 4.2, 0, 6.2832);
        ctx.fill();

        const la = s.t < 0.75 ? 1 : (1 - s.t) / 0.25;
        ctx.font = '600 12px "Space Grotesk", monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = `rgba(17,17,16,${(0.85 * la).toFixed(3)})`;
        ctx.fillText(s.label, x + 14, y - 10);
      }

      for (let i = ripples.current.length - 1; i >= 0; i--) {
        const r = ripples.current[i]!;
        r.t += 0.016;
        if (r.t < 0) continue;
        if (r.t >= 1) {
          ripples.current.splice(i, 1);
          continue;
        }
        const k = 1 - Math.pow(1 - r.t, 2);
        ctx.strokeStyle = `rgba(47,174,142,${(0.75 * (1 - r.t)).toFixed(3)})`;
        ctx.lineWidth = 2 - r.t;
        ctx.beginPath();
        ctx.arc(r.x * cw, r.y * ch, 4 + k * 64, 0, 6.2832);
        ctx.stroke();
        ctx.strokeStyle = `rgba(17,17,16,${(0.4 * (1 - r.t)).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(r.x * cw, r.y * ch, 4 + k * 36, 0, 6.2832);
        ctx.stroke();
      }
    };

    loop();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  return (
    <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
  );
}
