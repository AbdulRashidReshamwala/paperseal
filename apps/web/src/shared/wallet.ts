import { chain } from '@paperseal/protocol';
import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from 'viem';
import { sepolia } from 'viem/chains';

/*
 * The board's browser wallet, through viem's custom transport over the
 * EIP-1193 provider the wallet injects (`window.ethereum`). The app never
 * holds a key: the wallet signs and sends.
 */

if (sepolia.id !== chain.chainId) throw new Error('spec/constants.json chain does not match viem sepolia');

export type { EIP1193Provider };

/** The wallet the browser injects, or null when there is none. */
export function injectedProvider(): EIP1193Provider | null {
  const ethereum = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  return ethereum ?? null;
}

/** Asks the wallet to share an account. The wallet shows its own approval prompt. */
export async function requestAccount(provider: EIP1193Provider): Promise<Address> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const account = accounts[0];
  if (!account) throw new Error('The wallet shared no account.');
  return account;
}

/** The account the wallet currently exposes to this page, if any. Never prompts. */
export async function currentAccount(provider: EIP1193Provider): Promise<Address | null> {
  const accounts = await provider.request({ method: 'eth_accounts' });
  return accounts[0] ?? null;
}

export async function walletChainId(provider: EIP1193Provider): Promise<number> {
  return Number(BigInt(await provider.request({ method: 'eth_chainId' })));
}

/**
 * Asks the wallet to move to Sepolia, which shows the wallet's own prompt. Returns whether the wallet
 * is on Sepolia afterwards. A wallet that declines, or can't switch, leaves the caller to show the
 * plain instruction.
 */
export async function switchToSepolia(provider: EIP1193Provider): Promise<boolean> {
  try {
    if ((await walletChainId(provider)) === chain.chainId) return true;
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chain.chainId.toString(16)}` }] });
    return (await walletChainId(provider)) === chain.chainId;
  } catch {
    return false;
  }
}

/** A wallet client that sends through the wallet with `account`, on Sepolia. */
export function walletClientFor(provider: EIP1193Provider, account: Address): WalletClient {
  return createWalletClient({ account, chain: sepolia, transport: custom(provider) });
}
