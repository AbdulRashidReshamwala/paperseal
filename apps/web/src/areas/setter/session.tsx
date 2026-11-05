import type { checkToken } from '@paperseal/attestation';
import type { ExamRegistry } from '@paperseal/chain';
import type { Keys } from '@paperseal/keys';
import type { Hex } from '@paperseal/protocol';
import type { StatusResponse, TeeClient } from '@paperseal/tee-client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { browserKeys, describeError, loadCredential, type StoredCredential } from '../../shared/Register';
import { useCurrentExamId } from '../../shared/currentExam';
import { registry, registryAddress } from '../../shared/registry';
import { tee as defaultTee } from '../../shared/tee';
import { confirmTee, policyFromEnv, type ConfirmOutcome, type Confirmed, type TrustPolicy } from './confirm';

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
    policy: policyFromEnv(import.meta.env as Record<string, string | undefined>),
  };
}

interface Session {
  env: SetterEnv;
  examId: Hex | null;
  /** True when the TEE, chain and exam are all configured. */
  configured: boolean;
  credential: StoredCredential | null;
  setCredential: (credential: StoredCredential | null) => void;
  outcome: ConfirmOutcome | null;
  confirmed: Confirmed | null;
  checking: boolean;
  runConfirm: () => Promise<void>;
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
  const [credential, setCredential] = useState<StoredCredential | null>(() =>
    examId ? loadCredential(examId, 'setter') : null,
  );
  const [outcome, setOutcome] = useState<ConfirmOutcome | null>(null);
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
  }, [tee, chain, examId, env, refreshStatus]);

  const session = useMemo<Session>(
    () => ({
      env,
      examId,
      configured: Boolean(tee && chain && examId && env.registryAddress),
      credential,
      setCredential,
      outcome,
      confirmed: outcome?.ok ? outcome.confirmed : null,
      checking,
      runConfirm,
      status,
      statusError,
      refreshStatus,
    }),
    [env, examId, tee, chain, credential, outcome, checking, runConfirm, status, statusError, refreshStatus],
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
