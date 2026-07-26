import { shortAddr } from '../lib/format';
import type { useWallet } from '../lib/useWallet';

/**
 * Connect and unlock are two separate actions on purpose.
 *
 * Connecting only reveals an address. Unlocking produces the signature this
 * page needs to derive every note key the wallet has ever created — so it is
 * never a side effect of connecting, and the copy says what it does.
 */
export function WalletChip({
  wallet,
  live,
}: {
  wallet: ReturnType<typeof useWallet>;
  live: boolean;
}) {
  if (!live) {
    return (
      <span className="chip" style={{ padding: '8px 14px', fontSize: 12 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ink-25)' }} />
        simulated
      </span>
    );
  }

  const btn = (label: string, onClick: () => void, alarm = false) => (
    <button
      onClick={onClick}
      disabled={wallet.busy}
      className="chip"
      style={{
        padding: '8px 14px',
        fontSize: 12,
        cursor: wallet.busy ? 'wait' : 'pointer',
        fontFamily: 'inherit',
        borderColor: alarm ? 'var(--warn)' : undefined,
        color: alarm ? 'var(--warn)' : undefined,
      }}
    >
      {wallet.busy ? 'waiting…' : label}
    </button>
  );

  switch (wallet.status) {
    case 'disconnected':
      return btn('Connect wallet', () => void wallet.connect());

    case 'wrong-chain':
      return btn('Switch to Robinhood Chain', () => void wallet.switchChain(), true);

    case 'connected':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="chip" style={{ padding: '8px 14px', fontSize: 12 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)' }} />
            {shortAddr(wallet.account ?? '')}
          </span>
          {btn('Unlock private balance', () => void wallet.unlock())}
        </div>
      );

    case 'unlocked':
      return (
        <button
          onClick={wallet.lock}
          className="chip"
          title="Forget the derived keys on this device"
          style={{ padding: '8px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
          {shortAddr(wallet.account ?? '')}
        </button>
      );
  }
}

/** Shown in place of the action panels until the user can actually act. */
export function WalletGate({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  const copy: Record<string, { title: string; body: string; action?: string }> = {
    disconnected: {
      title: 'Connect a wallet',
      body: 'Connecting only shares your address. Deriving your note keys is a separate step you approve explicitly — and that signature is enough to reconstruct your whole private balance, so it is never done for you.',
      action: 'Connect wallet',
    },
    'wrong-chain': {
      title: 'Wrong network',
      body: 'This pool lives on Robinhood Chain (4663). Switch networks to continue.',
      action: 'Switch network',
    },
    connected: {
      title: 'Unlock your private balance',
      body: 'Sign one message to derive your note keys. It authorises no transaction and costs nothing. The same wallet reproduces the same keys on any device, so this is also how you recover.',
      action: 'Unlock private balance',
    },
  };

  const c = copy[wallet.status];
  if (!c) return null;

  const run = () => {
    if (wallet.status === 'disconnected') void wallet.connect();
    else if (wallet.status === 'wrong-chain') void wallet.switchChain();
    else if (wallet.status === 'connected') void wallet.unlock();
  };

  return (
    <div className="card-hero">
      <div className="display" style={{ fontWeight: 600, fontSize: 28, marginBottom: 14 }}>
        {c.title}
      </div>
      <p style={{ margin: '0 0 26px', fontSize: 14, lineHeight: 1.85, color: 'var(--ink-70)' }}>
        {c.body}
      </p>
      {c.action && (
        <button className="btn" onClick={run} disabled={wallet.busy}>
          {wallet.busy ? 'Waiting for wallet…' : c.action}
        </button>
      )}
      {wallet.error && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--alarm)', lineHeight: 1.7 }}>
          {wallet.error}
        </div>
      )}
    </div>
  );
}
