import type { checkToken } from '@paperseal/attestation';
import type { ExamRegistry } from '@paperseal/chain';
import type { Keys } from '@paperseal/keys';
import type { Hex } from '@paperseal/protocol';
import type { StatusResponse, TeeClient } from '@paperseal/tee-client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { browserKeys, describeError, loadCredential, type StoredCredential } from '../../shared/Register';
import { teeStorageBucket } from '../../shared/config';
import { useCurrentExamId } from '../../shared/currentExam';
import { registry, registryAddress } from '../../shared/registry';
import { tee as defaultTee } from '../../shared/tee';
import { CONFIRMATION_TTL_MS, confirmTee, type ConfirmOutcome, type Confirmed, type TrustPolicy } from './confirm';

/** Everything the setter flow talks to. The app wires the real ones, and a test can pass stubs. */
export interface SetterEnv {
  /** Null falls back to the current exam. */
  examId?: Hex | null;
  registryAddress: Hex | null;
  tee: Pick<
    TeeClient,
    'attestation' | 'status' | 'registerChallenge' | 'register' | 'questionChallenge' | 'question'
  > | null;
  chain: Pick<ExamRegistry, 'getExam' | 'getApprovedList' | 'getCriteria' | 'getBuild'> | null;
  keys: () => Pick<Keys, 'register' | 'sign'>;
  policy: TrustPolicy;
  /** The real `checkToken` unless a test swaps it. */
  verifyToken?: typeof checkToken;
}

export function defaultEnv(): SetterEnv {
  return {
    registryAddress: registryAddress,
    tee: defaultTee,
    chain: registry,
    keys: browserKeys,
    policy: { storageBucket: teeStorageBucket },
  };
}

interface Session {
  env: SetterEnv;
  examId: Hex | null;
  /** True when the TEE, chain and exam are all configured. */
  configured: boolean;
  /** Loaded for `examId`, so it follows the current exam. */
  credential: StoredCredential | null;
  /** Called with the credential `Register` just saved, for the current exam. */
  credentialSaved: (credential: StoredCredential) => void;
  outcome: ConfirmOutcome | null;
  confirmed: Confirmed | null;
  checking: boolean;
  runConfirm: () => Promise<void>;
  /** Drops a confirmation that can't be relied on, with the reason, so uploading closes at once. */
  dropConfirmation: (reason: string) => void;
  status: StatusResponse | null;
  statusError: string | null;
  refreshStatus: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession needs a SessionProvider');
  return session;
}

export function SessionProvider(props: { env: SetterEnv; children: ReactNode }) {
  const { env } = props;
  const currentExam = useCurrentExamId();
  const examId = env.examId === undefined ? currentExam : env.examId;
  // The credential is read per exam, so changing the current exam can never leave another exam's key in use.
  const [saved, setSaved] = useState<{ examId: Hex; credential: StoredCredential } | null>(null);
  const credentialSaved = useCallback(
    (registered: StoredCredential) => {
      if (examId) setSaved({ examId, credential: registered });
    },
    [examId],
  );
  const credential = useMemo(
    () => (saved && saved.examId === examId ? saved.credential : examId ? loadCredential(examId, 'setter') : null),
    [examId, saved],
  );
  // A confirmation is for one exam: another exam never inherits it.
  const [held, setHeld] = useState<{ examId: Hex | null; outcome: ConfirmOutcome | null }>({ examId: null, outcome: null });
  const outcome = held.examId === examId ? held.outcome : null;
  const setOutcome = useCallback(
    (next: ConfirmOutcome | null) => {
      setHeld({ examId, outcome: next });
    },
    [examId],
  );
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const { tee, chain } = env;

  const refreshStatus = useCallback(async () => {
    if (!tee) return;
    try {
      setStatus(await tee.status());
      setStatusError(null);
    } catch (error) {
      setStatus(null);
      setStatusError(describeError(error));
    }
  }, [tee]);

  useEffect(() => {
    if (!tee) return;
    let live = true;
    tee.status().then(
      (value) => {
        if (live) setStatus(value);
      },
      (error: unknown) => {
        if (live) setStatusError(describeError(error));
      },
    );
    return () => {
      live = false;
    };
  }, [tee]);

  const runConfirm = useCallback(async () => {
    if (!tee || !chain || !examId || !env.registryAddress) return;
    setChecking(true);
    // Any earlier pass is dropped first, so a failed re-check can never leave uploading open.
    setOutcome(null);
    try {
      setOutcome(
        await confirmTee({
          examId,
          registryAddress: env.registryAddress,
          tee,
          chain,
          policy: env.policy,
          ...(env.verifyToken ? { verifyToken: env.verifyToken } : {}),
        }),
      );
    } catch (error) {
      setOutcome({ ok: false, step: 'attestation', reasons: [describeError(error)] });
    } finally {
      setChecking(false);
    }
    await refreshStatus();
  }, [tee, chain, examId, env, refreshStatus, setOutcome]);

  const dropConfirmation = useCallback(
    (reason: string) => {
      setOutcome({ ok: false, step: 'attestation', reasons: [reason] });
    },
    [setOutcome],
  );

  // A confirmation is good for 5 minutes. Past that, uploading closes until the TEE is checked again.
  const confirmedAt = outcome?.ok ? outcome.confirmed.confirmedAt : null;
  useEffect(() => {
    if (confirmedAt === null) return;
    const left = Math.max(0, confirmedAt + CONFIRMATION_TTL_MS - Date.now());
    const timer = setTimeout(() => {
      dropConfirmation('The TEE confirmation expired after 5 minutes. Check the TEE again before sending.');
    }, left);
    return () => {
      clearTimeout(timer);
    };
  }, [confirmedAt, dropConfirmation]);

  const session = useMemo<Session>(
    () => ({
      env,
      examId,
      configured: Boolean(tee && chain && examId && env.registryAddress),
      credential,
      credentialSaved,
      outcome,
      confirmed: outcome?.ok ? outcome.confirmed : null,
      checking,
      runConfirm,
      dropConfirmation,
      status,
      statusError,
      refreshStatus,
    }),
    [env, examId, tee, chain, credential, credentialSaved, outcome, checking, runConfirm, dropConfirmation, status, statusError, refreshStatus],
  );
  return <SessionContext.Provider value={session}>{props.children}</SessionContext.Provider>;
}

const stageText: Record<string, string> = {
  publish: 'The exam is being published. Nothing can be submitted yet.',
  onboard: 'Onboarding: registrations are open. Submitting has not started.',
  submit: 'Submitting is open.',
  lock: 'Submitting has closed. The TEE is checking the question bank.',
  build: 'Submitting has closed. The paper is being built.',
  split: 'Submitting has closed. The paper key is being split.',
  distribute: 'Submitting has closed. Shares are being distributed.',
  unlock: 'Submitting has closed. The exam is at unlock.',
  verify: 'Submitting has closed.',
  released: 'Submitting has closed. The paper has been released.',
  failed: 'The exam failed at Lock and cannot go ahead. Submitting is closed.',
};

export function describeStage(stage: string): string {
  return stageText[stage] ?? `The TEE is at the ${stage} stage.`;
}
