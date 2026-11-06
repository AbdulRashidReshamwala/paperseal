/*
 * The e2e mock suite (`pnpm --filter @paperseal/e2e ui:mock`) runs these apps against a mock sealed
 * machine whose attestation token is signed by a throwaway test root, not Google's. This file is the only
 * place that lets the apps trust that root, and only when Vite runs in its own `mock` mode.
 *
 * It cannot reach a production build, for three reasons:
 *   - Vite replaces `import.meta.env.MODE` with a literal, so in a production build every branch below is
 *     dead code and is removed, together with the value read inside it.
 *   - `vite.config.ts` refuses to build in `mock` mode.
 *   - `mockMode.test.ts` builds the app and checks the output holds neither the root nor the label.
 */

/** True only in the mock suite's dev servers. */
export const mockMode: boolean = import.meta.env.MODE === 'mock';

/** The DER root the mock suite's tokens chain to. Undefined everywhere else, so Google's pinned root applies. */
export function mockTrustedRoot(): Uint8Array | undefined {
  if (import.meta.env.MODE !== 'mock') return undefined;
  const base64 = (import.meta.env as Record<string, string | undefined>).VITE_MOCK_TRUST_ROOT;
  if (!base64) return undefined;
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** The `trustedRoot` option for `checkToken`, empty outside the mock suite. */
export function rootOption(): { trustedRoot?: Uint8Array } {
  const root = mockTrustedRoot();
  return root ? { trustedRoot: root } : {};
}
