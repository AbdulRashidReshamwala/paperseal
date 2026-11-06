import { arkiv, createArkivReader } from '@paperseal/arkiv';
import { createExamRegistry } from '@paperseal/chain';
import { quicknetClient, type ChainClient } from '@paperseal/crypto';
import type { Hex } from '@paperseal/protocol';
import { createTeeClient } from '@paperseal/tee-client';
import { createContext, use, useMemo, useState, type ReactNode } from 'react';
import { getAddress, isAddress } from 'viem';

import { createStorage } from './storage';

/** Who this viewer trusts. Stored in their browser, so the board can't choose for them. */
export interface Settings {
  rpcUrl: string;
  teeUrl: string;
  /** Base URL of the public bucket. Files live under `<examId>/` there. */
  storageUrl: string;
  registryAddress: string;
  examId: string;
  /** The Arkiv node the evidence mirror is read from. */
  arkivRpcUrl: string;
  /** The Arkiv writers this viewer trusts to find rows, comma-separated. Empty turns Arkiv off. */
  arkivWriters: string;
}

const STORAGE_KEY = 'paperseal.verifier.settings';

const env = import.meta.env as Record<string, string | undefined>;

/** Build-time defaults. All empty means nothing is contacted until the viewer sets a URL. */
export const defaultSettings: Settings = {
  rpcUrl: env.VITE_RPC_URL ?? '',
  teeUrl: env.VITE_TEE_URL ?? '',
  storageUrl: env.VITE_STORAGE_URL ?? '',
  registryAddress: env.VITE_REGISTRY_ADDRESS ?? '',
  examId: env.VITE_EXAM_ID ?? '',
  arkivRpcUrl: arkiv.network.rpcUrl,
  arkivWriters: env.VITE_ARKIV_WRITERS ?? '',
};

/** The writer addresses in `arkivWriters`, in the order given. Empty entries are skipped. */
export const arkivWriterList = (text: string): Hex[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '') as Hex[];

/** Where a writer the page reads came from: the exam's name, the viewer, or this page's build. */
export type WriterOrigin = 'name' | 'own' | 'built';

export interface SourcedWriter {
  address: Hex;
  /** Every place that lists it, in that order. */
  from: WriterOrigin[];
}

/** A writer with its checksum. One with a bad checksum is kept as written, so reading it fails loudly. */
function checksummed(writer: string): Hex {
  try {
    return getAddress(writer);
  } catch {
    return writer as Hex;
  }
}

/**
 * The writers to read, as spec/arkiv.md "Writers" says: the ones the exam's name lists now, if
 * any, and the viewer's own, each once. A viewer's writer that is also built into this page counts
 * as built in. Without a name, these are the viewer's own writers.
 */
export function arkivWriters(own: string, fromName: readonly string[] | null, built: string = defaultSettings.arkivWriters): SourcedWriter[] {
  const builtIn = new Set(arkivWriterList(built).map(checksummed));
  const merged = new Map<Hex, WriterOrigin[]>();
  const add = (writer: string, origin: WriterOrigin) => {
    const address = checksummed(writer);
    const from = merged.get(address) ?? [];
    if (!from.includes(origin)) from.push(origin);
    merged.set(address, from);
  };
  for (const writer of fromName ?? []) add(writer, 'name');
  for (const writer of arkivWriterList(own)) add(writer, builtIn.has(checksummed(writer)) ? 'built' : 'own');
  return [...merged].map(([address, from]) => ({ address, from }));
}

/** Each writer must be an address, and one written in mixed case must have a valid checksum. */
function writerError(text: string): string | undefined {
  for (const writer of arkivWriterList(text)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(writer)) {
      return 'Enter each address as 0x followed by 40 letters or digits, with commas between them.';
    }
    if (!isAddress(writer, { strict: true })) {
      return `${writer} has a typing mistake in its capital letters. Copy it again, or write it all in lower case.`;
    }
  }
  return undefined;
}

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

/** A 32-byte exam ID in the one form the verifier uses: lowercase hex. */
export const isExamId = (value: string) => /^0x[0-9a-f]{64}$/.test(value);

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
  if (settings.rpcUrl && !isHttpUrl(settings.rpcUrl)) errors.rpcUrl = 'Enter a web address that starts with http:// or https://.';
  if (settings.teeUrl && !isHttpUrl(settings.teeUrl)) errors.teeUrl = 'Enter a web address that starts with http:// or https://.';
  if (settings.storageUrl && !isHttpUrl(settings.storageUrl)) errors.storageUrl = 'Enter a web address that starts with http:// or https://.';
  if (settings.registryAddress && !/^0x[0-9a-fA-F]{40}$/.test(settings.registryAddress)) {
    errors.registryAddress = 'Enter 0x followed by 40 letters or digits.';
  }
  if (settings.arkivRpcUrl && !isHttpUrl(settings.arkivRpcUrl)) {
    errors.arkivRpcUrl = 'Enter a web address that starts with http:// or https://.';
  }
  const writers = writerError(settings.arkivWriters);
  if (writers) errors.arkivWriters = writers;
  if (settings.examId && !isExamId(settings.examId)) {
    errors.examId = 'Enter an exam ID: 0x followed by 64 letters or digits.';
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

/**
 * Clients for these endpoints. Each is null until its values are present. An exam name passes its
 * own registry, exam, TEE and storage here for one view, with the viewer's RPC. Registry reads never
 * follow an offchain lookup to a gateway: `ExamRegistry` never asks for one, and on a name route its
 * address came from ENS.
 */
export function endpoints(settings: Pick<Settings, 'rpcUrl' | 'teeUrl' | 'storageUrl' | 'registryAddress' | 'examId'>) {
  const { rpcUrl, teeUrl, storageUrl, registryAddress, examId } = settings;
  return {
    /** The public files. Needs the exam ID too, because they live under it. */
    storage: storageUrl && examId ? createStorage(storageUrl, examId as Hex) : null,
    tee: teeUrl ? createTeeClient({ baseUrl: teeUrl }) : null,
    registry:
      rpcUrl && registryAddress
        ? createExamRegistry({ rpcUrl, address: registryAddress as Hex, ccipRead: false })
        : null,
    examId: examId ? (examId as Hex) : null,
  };
}

/**
 * The Arkiv mirror, read with the viewer's own node and writers. Off, with nothing read, until both
 * are set. A name route adds the name's writers to these, and reads them with the same node.
 */
export function arkivSource(settings: Pick<Settings, 'arkivRpcUrl' | 'arkivWriters'>) {
  const writers = arkivWriterList(settings.arkivWriters);
  return settings.arkivRpcUrl && writers.length > 0
    ? { reader: createArkivReader({ rpcUrl: settings.arkivRpcUrl }), writers }
    : null;
}

/** Clients for the viewer's own endpoints. Each is null until its settings are present. */
export function connect(settings: Settings) {
  return {
    ...endpoints(settings),
    arkiv: arkivSource(settings),
    /** drand quicknet, pinned to the chain hash and public key in spec/constants.json. */
    drand: quicknetClient(),
  };
}

type Connections = ReturnType<typeof connect>;

interface SettingsContextValue extends Connections {
  settings: Settings;
  apply: (settings: Settings) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider(props: {
  children: ReactNode;
  initial?: Settings;
  /** Replaces the live drand client. For tests. */
  drand?: ChainClient;
}) {
  const [settings, setSettings] = useState<Settings>(() => props.initial ?? loadSettings());
  const value = useMemo<SettingsContextValue>(
    () => ({
      ...connect(settings),
      ...(props.drand ? { drand: props.drand } : {}),
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
    [settings, props.drand],
  );
  return <SettingsContext value={value}>{props.children}</SettingsContext>;
}

export function useConnections(): SettingsContextValue {
  const value = use(SettingsContext);
  if (!value) throw new Error('useConnections needs a SettingsProvider');
  return value;
}
