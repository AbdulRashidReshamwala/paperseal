import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';

import type { GatedRole } from './RolePage';

/*
 * Demo keys (`pnpm demo:keys`): one tab acts as every person in an exam, each with a planted key from
 * a public seed. See apps/web/src/demo. This file is the only door to that code. It is shut unless Vite
 * runs in its own `demo-keys` mode, or in the e2e mock suite's mode, with VITE_DEMO_KEYS=1.
 *
 * It cannot reach a production build, for three reasons:
 *   - Vite replaces `import.meta.env.MODE` with a literal, so in a production build the branches below
 *     are dead code and are removed, together with the dynamic imports inside them. The test inside each
 *     function has to stay there: the bundler only removes a branch it can decide within this file.
 *   - `vite.config.ts` refuses to build in `demo-keys` mode, and refuses VITE_DEMO_KEYS in any other.
 *   - `demoKeys.test.ts` builds the app and checks the output holds no trace of it.
 */

const on = (import.meta.env.MODE === 'demo-keys' || import.meta.env.MODE === 'mock') && import.meta.env.VITE_DEMO_KEYS === '1';

/** Gives each tab its own person's storage. Runs before the app first reads storage. Nothing outside demo mode. */
export async function prepareDemo(): Promise<void> {
  if (!on) return;
  const { scopeStorage } = await import('../demo/personas');
  scopeStorage();
}

/** The bar across the top of the app. Null outside demo mode. */
export function demoBar(): LazyExoticComponent<ComponentType> | null {
  if (!on) return null;
  return lazy(() => import('../demo/DemoBar'));
}

/** Decides a role by the person in the bar. Null outside demo mode. */
export function demoGate(): LazyExoticComponent<ComponentType<{ role: GatedRole; children: ReactNode }>> | null {
  if (!on) return null;
  return lazy(() => import('../demo/PersonaGate'));
}

/**
 * The board's panel for doing everyone else's part. Null outside demo mode. The caller names its props,
 * because this file sits in the entry bundle and may not import a board type.
 */
export function demoPanel<Props extends object>(): LazyExoticComponent<ComponentType<Props>> | null {
  if (!on) return null;
  return lazy(() => import('../demo/BoardPanel') as unknown as Promise<{ default: ComponentType<Props> }>);
}

/** Two small topics for the create page, so a demo's bank is small. Null outside demo mode. */
export function demoTopics(): { name: string; questions: string }[] | null {
  if (!on) return null;
  return ['Mathematics', 'Physics'].map((name) => ({ name, questions: '2' }));
}

/** Six minutes to close: two to publish and start the machine, then four on camera. In the date picker's local format. Null outside demo mode. */
export function demoTimes(now = new Date()): {
  examStart: string;
  lockTime: string;
  durationMinutes: string;
  releaseMinutes: string;
  maxSetterPercent: string;
  minBankMultiple: string;
} | null {
  if (!on) return null;
  const minute = 60_000;
  const nextMinute = Math.ceil(now.getTime() / minute) * minute;
  const local = (minutes: number) => {
    const at = new Date(nextMinute + minutes * minute);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  };
  return { examStart: local(8), lockTime: local(6), durationMinutes: '1', releaseMinutes: '1', maxSetterPercent: '50', minBankMultiple: '2' };
}

/** How many setters a demo has, to fill the invites in one click. Null outside demo mode. */
export function demoSetters(): number | null {
  if (!on) return null;
  return 5;
}

/** The `credentials` option for `createWebAuthnKeys`, empty outside demo mode, so the browser's real one applies. */
export function credentialsOption(): { credentials?: Pick<CredentialsContainer, 'create' | 'get'> } {
  if (!on) return {};
  const demo = () => import('../demo/credentials').then(({ demoCredentials }) => demoCredentials());
  return {
    credentials: {
      create: async (options) => (await demo()).create(options),
      get: async (options) => (await demo()).get(options),
    },
  };
}
