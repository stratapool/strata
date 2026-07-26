import type { PrivacyAssessment, PrivacyTier } from './types';

/**
 * Anonymity-set size at which the pool is considered genuinely usable.
 * Sourced from practitioner guidance: 2,000–5,000+ unspent notes at the same
 * denomination. Below that the protection is real but thin; well below it,
 * there is effectively none.
 */
export const USABLE_ANON_SET = 5000;

const TIER_BOUNDS: { max: number; tier: PrivacyTier }[] = [
  { max: 20, tier: 'critical' },
  { max: 200, tier: 'thin' },
  { max: 2000, tier: 'ok' },
  { max: Infinity, tier: 'strong' },
];

export function tierFor(anonSet: number): PrivacyTier {
  return TIER_BOUNDS.find((b) => anonSet < b.max)!.tier;
}

/**
 * Set size is the ceiling; waiting only modulates underneath it.
 *
 * These must NOT be additive. Waiting does not create anonymity — it only
 * lets you make use of anonymity that already exists. If time contributed
 * independently, a pool holding fourteen notes could score in the forties
 * just because the user sat on it overnight, which is precisely the
 * reassuring lie this component exists to avoid.
 *
 * Set size is log-scaled because the marginal privacy of one more note falls
 * off fast: 10 → 100 matters far more than 4,000 → 4,090.
 */
export function scoreFor(anonSet: number, ageHours: number): number {
  const setCeiling =
    (100 * Math.log10(Math.max(1, anonSet))) / Math.log10(USABLE_ANON_SET);
  // Approaches 1 over a couple of days, then stops mattering.
  const timeFactor = 1 - Math.exp(-ageHours / 18);
  const raw = setCeiling * (0.6 + 0.4 * timeFactor);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function assess(
  effectiveAnonSet: number,
  ageHours: number,
): PrivacyAssessment {
  const tier = tierFor(effectiveAnonSet);
  const score = scoreFor(effectiveAnonSet, ageHours);

  // Only suggest waiting while it still buys a meaningful amount.
  const waitHours = ageHours < 36 ? Math.ceil(Math.max(1, 24 - ageHours)) : null;
  const scoreAfterWait =
    waitHours === null ? null : scoreFor(effectiveAnonSet, ageHours + waitHours);

  const copy: Record<PrivacyTier, { headline: string; detail: string }> = {
    critical: {
      headline: `Only ${effectiveAnonSet.toLocaleString()} notes in the set`,
      detail:
        'Withdrawing now is close to publishing the link yourself. Anyone comparing deposits and withdrawals can narrow it to you. Wait for the pool to fill.',
    },
    thin: {
      headline: 'The set is still thin',
      detail:
        'There is real cover here, but not much. Waiting costs you nothing and is worth more than anything else you can do right now.',
    },
    ok: {
      headline: 'Reasonable cover',
      detail:
        'Your note is one of a few thousand. Waiting longer still helps — deposits made while you wait land behind yours.',
    },
    strong: {
      headline: 'Strong cover',
      detail:
        'Your note is indistinguishable from thousands of others at the same denomination.',
    },
  };

  return {
    score,
    tier,
    effectiveAnonSet,
    headline: copy[tier].headline,
    detail: copy[tier].detail,
    suggestedWaitHours: waitHours,
    scoreAfterWait: scoreAfterWait === score ? null : scoreAfterWait,
    requiresConfirmation: tier === 'critical',
  };
}

export const TIER_COLOR: Record<PrivacyTier, string> = {
  critical: '#c8422f',
  thin: '#d98324',
  ok: '#111110',
  strong: '#2fae8e',
};
