import { describe, expect, it } from 'vitest';
import { assess, scoreFor, tierFor } from './privacy';

describe('scoreFor', () => {
  it('treats anonymity-set size as a ceiling, not one term among many', () => {
    // The failure this guards against: a tiny pool scoring respectably just
    // because the note sat overnight. Waiting cannot manufacture cover.
    const tinySetLongWait = scoreFor(14, 72);
    const bigSetNoWait = scoreFor(5000, 0);
    expect(tinySetLongWait).toBeLessThan(35);
    expect(bigSetNoWait).toBeGreaterThan(tinySetLongWait);
  });

  it('never lets waiting exceed what the set supports', () => {
    for (const set of [1, 5, 14, 60, 200, 900, 5000]) {
      const ceiling = scoreFor(set, 1e6);
      const floor = scoreFor(set, 0);
      expect(floor).toBeLessThanOrEqual(ceiling);
      // Time may only modulate within 60–100% of the ceiling.
      expect(floor).toBeGreaterThanOrEqual(Math.floor(ceiling * 0.55));
    }
  });

  it('bottoms out at zero for a set of one', () => {
    expect(scoreFor(1, 999)).toBe(0);
  });

  it('is monotonic in set size', () => {
    const sets = [1, 10, 100, 1000, 5000];
    const scores = sets.map((s) => scoreFor(s, 24));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });
});

describe('tierFor', () => {
  it('classifies cold-start pools as critical', () => {
    expect(tierFor(1)).toBe('critical');
    expect(tierFor(19)).toBe('critical');
    expect(tierFor(20)).toBe('thin');
    expect(tierFor(199)).toBe('thin');
    expect(tierFor(2000)).toBe('strong');
  });
});

describe('assess', () => {
  it('demands a second confirmation only while the set is critical', () => {
    expect(assess(6, 48).requiresConfirmation).toBe(true);
    expect(assess(600, 48).requiresConfirmation).toBe(false);
  });

  it('stops suggesting a wait once waiting has stopped helping', () => {
    expect(assess(5000, 100).suggestedWaitHours).toBeNull();
    expect(assess(5000, 1).suggestedWaitHours).not.toBeNull();
  });

  it('reports the effective set it was given, never a rounded-up figure', () => {
    expect(assess(37, 5).effectiveAnonSet).toBe(37);
  });
});
