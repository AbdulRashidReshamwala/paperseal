import { createExamRegistry } from '@paperseal/chain';
import type { Hex } from '@paperseal/protocol';
import { createTeeClient } from '@paperseal/tee-client';
import { createContext, use, useMemo, useState, type ReactNode } from 'react';

/** Who this viewer trusts. Stored in their browser, so the board can't choose for them. */
export interface Settings {
  rpcUrl: string;
  teeUrl: string;
  registryAddress: string;
  examId: string;
}

const STORAGE_KEY = 'paperseal.verifier.settings';

const env = import.meta.env as Record<string, string | undefined>;

/** Build-time defaults. All empty means nothing is contacted until the viewer sets a URL. */
export const defaultSettings: Settings = {
  rpcUrl: env.VITE_RPC_URL ?? '',
  teeUrl: env.VITE_TEE_URL ?? '',
  registryAddress: env.VITE_REGISTRY_ADDRESS ?? '',
  examId: env.VITE_EXAM_ID ?? '',
};

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Empty is allowed: it means that source is not connected. */
export function validateSettings(settings: Settings): SettingsErrors {
  const errors: SettingsErrors = {};
  if (settings.rpcUrl && !isHttpUrl(settings.rpcUrl)) errors.rpcUrl = 'Enter an http or https URL.';
  if (settings.teeUrl && !isHttpUrl(settings.teeUrl)) errors.teeUrl = 'Enter an http or https URL.';
  if (settings.registryAddress && !/^0x[0-9a-fA-F]{40}$/.test(settings.registryAddress)) {
    errors.registryAddress = 'Enter a 20-byte address starting with 0x.';
  }
  if (settings.examId && !/^0x[0-9a-f]{64}$/.test(settings.examId)) {
    errors.examId = 'Enter a 32-byte lowercase hex ID starting with 0x.';
  }
  return errors;
}

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): SettingsStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Saved values override defaults. Anything unreadable or invalid falls back to them. */
export function loadSettings(storage = browserStorage()): Settings {
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as Partial<Settings> | null;
    const merged = { ...defaultSettings, ...saved };
    return Object.keys(validateSettings(merged)).length === 0 ? merged : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: Settings, storage = browserStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private windows can refuse storage. The settings still apply to this visit.
  }
}

export function clearSettings(storage = browserStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was stored.
  }
}

/** Clients for the viewer's own endpoints. Each is null until its settings are present. */
export function connect(settings: Settings) {
  const { rpcUrl, teeUrl, registryAddress, examId } = settings;
  return {
    tee: teeUrl ? createTeeClient({ baseUrl: teeUrl }) : null,
    registry:
      rpcUrl && registryAddress
        ? createExamRegistry({ rpcUrl, address: registryAddress as Hex })
        : null,
    examId: examId ? (examId as Hex) : null,
  };
}

type Connections = ReturnType<typeof connect>;

interface SettingsContextValue extends Connections {
  settings: Settings;
  apply: (settings: Settings) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider(props: { children: ReactNode; initial?: Settings }) {
  const [settings, setSettings] = useState<Settings>(() => props.initial ?? loadSettings());
  const value = useMemo<SettingsContextValue>(
    () => ({
      ...connect(settings),
      settings,
      apply: (next) => {
        saveSettings(next);
        setSettings(next);
      },
      reset: () => {
        clearSettings();
        setSettings(defaultSettings);
      },
    }),
    [settings],
  );
  return <SettingsContext value={value}>{props.children}</SettingsContext>;
}

export function useConnections(): SettingsContextValue {
  const value = use(SettingsContext);
  if (!value) throw new Error('useConnections needs a SettingsProvider');
  return value;
}
