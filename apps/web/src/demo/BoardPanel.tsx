import { examIdInToken } from '../shared/machineExam';
import type { Hex } from '@paperseal/protocol';
import { Button, Check, PrimaryAction, Row, Rows } from '@paperseal/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Snapshot } from '../areas/board/examState';
import { loadInvites } from '../areas/board/invites';
import { confirmTee } from '../areas/setter/confirm';
import type { PendingSubmission } from '../areas/setter/submit';
import { releaseContext } from '../release/ReleaseStage';
import { teeStorageBucket } from '../shared/config';
import { nameLookup } from '../shared/names';
import { registry, registryAddress } from '../shared/registry';
import { tee } from '../shared/tee';
import { keysFor } from './credentials';
import { questionJobs, registerJobs, releaseEnough, releaseJobs, runEach, type Job, type PersonState, type World } from './everyone';
import { personas, withStorageOf } from './personas';

/*
 * On the board's exam page in demo mode only, through the door in shared/demoKeys.ts. One button per
 * stage does everyone who is left, so a person can show one setter and one centre by hand.
 *
 * The chosen names come in as a prop: `areas/board/parties.ts` brings the board's posting code with it,
 * and every page can reach this file through the door, as far as boundaries.test.ts can tell.
 */

interface PanelProps {
  examId: Hex;
  snapshot: Snapshot;
  /** The names the board chose for this exam. */
  parties: readonly { name: string }[];
}

type PanelStage = 'register' | 'questions' | 'release';

const LOOK_AGAIN_MS = 10_000;

/** The stage comes from the sealed machine, so a button shows only when its requests can be accepted. */
export function panelStage(examId: Hex, { status, list, build }: Snapshot): PanelStage | null {
  if (!status || (status.examId && status.examId.toLowerCase() !== examId.toLowerCase())) return null;
  if (!list) return status.stage === 'onboard' ? 'register' : null;
  if (!build) return status.stage === 'submit' ? 'questions' : null;
  return status.stage === 'unlock' || status.stage === 'released' ? 'release' : null;
}

const copy: Record<PanelStage, { what: string; action: string; busy: string }> = {
  register: { what: 'Registers the setters, key holders and centres who have not registered yet.', action: 'Register everyone else', busy: 'Registering' },
  questions: { what: 'Adds sample questions for the setters who still need them, so the exam meets its limits.', action: 'Add questions for everyone else', busy: 'Adding questions' },
  release: { what: 'Releases the parts of the key that are still needed. Centres then open the paper on their own pages.', action: 'Release the rest', busy: 'Releasing' },
};

function world(examId: Hex): World | null {
  if (!tee || !registry || !registryAddress || !nameLookup) return null;
  const [client, reader, address] = [tee, registry, registryAddress];
  return {
    examId,
    tee: client,
    lookup: nameLookup,
    registry: reader,
    keysFor,
    storageOf: withStorageOf,
    confirm: () => confirmTee({ examId, registryAddress: address, tee: client, chain: reader, policy: { storageBucket: teeStorageBucket } }),
    releaseContext: (credential, derivedPublicKey, keys) => releaseContext(examId, credential, derivedPublicKey, keys),
  };
}

interface Plan {
  jobs: Job[];
  note: string | null;
}

const setterCount = personas.filter(({ path }) => path === '/setter').length;

/** What is left to tell the board about the setters, once the invites are paired up. */
function setterNote(needed: number, jobs: readonly Job[]): string | null {
  if (needed > setterCount) return `This exam needs at least ${String(needed)} setters, and there are ${String(setterCount)} here.`;
  const short = needed - jobs.filter(({ persona }) => persona.path === '/setter').length;
  if (short <= 0) return null;
  return `This exam needs ${String(short)} more ${short === 1 ? 'setter invite' : 'setter invites'}. Add them above, then press the button.`;
}

async function planFor(stage: PanelStage, acting: World, { snapshot, parties }: Omit<PanelProps, 'examId'>, pending: Map<string, { current: PendingSubmission | null }>): Promise<Plan> {
  const { examId } = acting;
  const criteria = snapshot.found?.criteria ?? null;
  const entries = snapshot.list?.entries ?? [];
  if (stage === 'register') {
    const { registrations } = await acting.tee.registrations();
    const jobs = await registerJobs(acting, { invites: loadInvites(examId), parties, registrations });
    return { jobs, note: setterNote(criteria ? Math.ceil(100 / criteria.maxSetterPercent) : 0, jobs) };
  }
  if (stage === 'questions') {
    if (!criteria) return { jobs: [], note: 'The topics could not be read. This page keeps trying.' };
    const { jobs, problem } = await questionJobs(acting, { criteria, entries, pending });
    return { jobs, note: problem };
  }
  const { release } = await acting.tee.status();
  return { jobs: await releaseJobs(acting, { entries, released: release.released }), note: null };
}

function Line(props: { job: Job; state: PersonState | undefined; idle: boolean; onRetry: () => void }) {
  const { job, idle } = props;
  const waiting: PersonState = { kind: 'waiting', ...(job.note ? { note: job.note } : {}) };
  const state = props.state ?? (job.done ? ({ kind: 'done', note: 'Already done' } as const) : waiting);
  switch (state.kind) {
    case 'done':
      return <Check status="pass">{state.note}</Check>;
    case 'not-needed':
      return <Check status="not-checked">Not needed</Check>;
    case 'working':
      return <Check status="pending">{state.note}</Check>;
    case 'failed':
      return (
        <span className="board-link">
          <Check status="fail">{state.reason}</Check>
          {idle ? (
            <Button aria-label={`Try again for ${job.persona.label}`} onClick={props.onRetry}>
              Try again
            </Button>
          ) : null}
        </span>
      );
    default:
      return <Check status="not-checked">{state.note ?? 'Waiting'}</Check>;
  }
}

function Everyone(props: PanelProps & { stage: PanelStage }) {
  const { stage, examId } = props;
  const acting = useMemo(() => world(examId), [examId]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, PersonState>>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Map<string, { current: PendingSubmission | null }>());
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const look = useCallback(async () => {
    if (!acting) return null;
    try {
      // The machine serves one exam. Its status doesn't name it, so its stage alone could be another exam's.
      const machine = examIdInToken((await acting.tee.attestation()).token);
      if (machine?.toLowerCase() !== acting.examId.toLowerCase()) {
        setPlan(null);
        return null;
      }
      const next = await planFor(stage, acting, latest.current, pending.current);
      setPlan(next);
      setProblem(null);
      return next;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [acting, stage]);

  useEffect(() => {
    if (busy) return;
    void look();
    const id = setInterval(() => void look(), LOOK_AGAIN_MS);
    return () => {
      clearInterval(id);
    };
  }, [busy, look]);

  const run = async (only?: string) => {
    if (!acting || busy) return;
    setBusy(true);
    const fresh = await look();
    if (fresh) {
      await runEach(only ? fresh.jobs.filter(({ persona }) => persona.id === only) : fresh.jobs, {
        onState: (id, state) => {
          setStates((all) => ({ ...all, [id]: state }));
        },
        ...(stage === 'release' ? { enough: async () => releaseEnough(await acting.tee.status()) } : {}),
      });
    }
    setBusy(false);
  };

  if (!acting || !plan) return null;
  const { what, action, busy: busyLabel } = copy[stage];
  const { status } = props.snapshot;
  const enough = stage === 'release' && status !== null && releaseEnough(status);
  const left = !enough && plan.jobs.some((job) => !job.done && !['done', 'not-needed'].includes(states[job.persona.id]?.kind ?? ''));
  return (
    <section className="board-draft-card board-people-job" aria-label="Everyone else">
      <h2>Everyone else</h2>
      <p className="board-note">{what}</p>
      {plan.note ? <p className="board-note">{plan.note}</p> : null}
      {problem ? <p className="board-note">This could not be read just now. The page keeps trying. {problem}</p> : null}
      {left || busy ? (
        <PrimaryAction status={busy ? 'busy' : 'idle'} busyLabel={busyLabel} onClick={() => void run()}>
          {action}
        </PrimaryAction>
      ) : null}
      {plan.jobs.length > 0 ? (
        <Rows>
          {plan.jobs.map((job) => (
            <Row key={job.persona.id} label={job.persona.label}>
              <Line job={job} state={states[job.persona.id] ?? (enough && !job.done ? { kind: 'not-needed' } : undefined)} idle={!busy} onRetry={() => void run(job.persona.id)} />
            </Row>
          ))}
        </Rows>
      ) : null}
    </section>
  );
}

export default function BoardPanel(props: PanelProps) {
  const stage = panelStage(props.examId, props.snapshot);
  return stage ? <Everyone key={stage} stage={stage} {...props} /> : null;
}
