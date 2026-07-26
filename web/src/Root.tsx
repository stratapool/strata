import { lazy, Suspense, useEffect, useState } from 'react';
import { Landing } from './pages/Landing';
import { isLive } from './lib/usePool';

/**
 * Split off deliberately. The app route pulls in AppKit, its wallet
 * connectors and the note/merkle libraries — around 2.5 MB that the landing
 * page has no use for. Loading it only when someone actually opens the app
 * keeps first paint on a page people are being asked to evaluate before
 * trusting it.
 */
const PoolApp = lazy(() =>
  import('./pages/PoolApp').then((m) => ({ default: m.PoolApp })),
);

/**
 * Simulated builds still get a banner: every number on them is fabricated,
 * and a privacy product showing an invented TVL without saying so is doing
 * the exact thing it asks to be trusted about.
 *
 * The live build carries no site-wide banner by product decision. The risk
 * disclosure lives next to the deposit button instead — see RiskNote in
 * PoolApp, which is the last thing a user reads before committing funds.
 */
function Banner({ live }: { live: boolean }) {
  if (live) return null;
  return (
    <div className="demo-banner">
      Demo build · all figures are simulated · nothing is deployed on-chain yet
    </div>
  );
}

export function Root() {
  const [route, setRoute] = useState(() => location.hash.replace('#', '') || '/');

  useEffect(() => {
    const onHash = () => setRoute(location.hash.replace('#', '') || '/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      <Banner live={isLive()} />
      {route.startsWith('/app') ? (
        <Suspense
          fallback={
            <div
              className="shell-narrow eyebrow"
              style={{ paddingTop: 120, textAlign: 'center' }}
            >
              Loading…
            </div>
          }
        >
          <PoolApp />
        </Suspense>
      ) : (
        <Landing />
      )}
    </>
  );
}
