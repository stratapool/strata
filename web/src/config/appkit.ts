import { createAppKit } from '@reown/appkit/react';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { defineChain } from '@reown/appkit/networks';

export const ROBINHOOD_CHAIN_ID = 4663;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  caipNetworkId: `eip155:${ROBINHOOD_CHAIN_ID}`,
  chainNamespace: 'eip155',
  name: 'Robinhood Chain',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: {
    default: {
      http: [
        import.meta.env.VITE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
      ],
    },
  },
});

const projectId =
  import.meta.env.VITE_REOWN_PROJECT_ID ?? 'ff0ff3c6373af8a09c7cb958e6312eac';

let started = false;

/**
 * Initialises Reown AppKit once.
 *
 * Two settings here are not cosmetic:
 *
 *  - `analytics: false`. AppKit otherwise reports connection events to Reown.
 *    A privacy pool that phones home every time someone connects a wallet is
 *    leaking the one fact its users came here to avoid publishing.
 *  - `email`/`socials` disabled. Those flows hand an identity to a third-party
 *    custodian, which is the opposite of what this product does.
 *
 * WalletConnect still relays pairing through Reown's servers, so the relay
 * observes that *some* address connected to this dapp from some IP. It does
 * not see withdrawals — those go through our own relayer — but users who need
 * to hide even the fact of using Strata should connect an injected wallet
 * over Tor rather than scanning a QR code.
 */
export function initAppKit(): void {
  if (started) return;
  started = true;

  createAppKit({
    adapters: [new EthersAdapter()],
    networks: [robinhoodChain],
    defaultNetwork: robinhoodChain,
    projectId,
    metadata: {
      name: 'Strata',
      description: 'Fixed-denomination privacy pool on Robinhood Chain',
      url: 'https://stratapool.xyz',
      icons: ['https://stratapool.xyz/icon.png'],
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
    },
    themeMode: 'light',
    themeVariables: {
      '--w3m-accent': '#2fae8e',
      '--w3m-color-mix': '#111110',
      '--w3m-color-mix-strength': 8,
      '--w3m-border-radius-master': '0px',
      '--w3m-font-family': "'Space Grotesk', ui-monospace, monospace",
    },
  });
}
