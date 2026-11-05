import type { Hex } from '@paperseal/protocol';
import { Check, Row, Rows, Stage } from '@paperseal/ui';
import { useEffect, useState } from 'react';

import { verifyTee } from '../../shared/attest';
import { useCurrentExamId } from '../../shared/currentExam';
import { useBoardForm, useReader } from './BoardForm';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { OutboxError, verifyOutboxBuild } from './outbox';
import { PostAction, Problem } from './Parts';
import { postBuildFlow, type BuildPost, type PostOutcome } from './postFlow';

type Checked = { state: 'checking' } | { state: 'ready'; build: BuildPost } | { state: 'blocked'; reason: string };

/**
 * Verifies the outbox message before the wallet can be asked: the TEE must attest for this exam,
 * and the Build must carry its signature under the attested key.
 */
function useVerifiedBuild(snapshot: Snapshot): Checked {
  const { tee } = useBoardForm();
  const reader = useReader();
  const examId = useCurrentExamId();
  const message = snapshot.outbox[0] ?? null;
  const signature = message?.teeSignature ?? '';
  const [result, setResult] = useState<{ key: string; checked: Exclude<Checked, { state: 'checking' }> } | null>(null);
  const key = `${examId ?? ''}:${signature}`;

  useEffect(() => {
    if (!tee || !reader || !examId || !message) return;
    let live = true;
    const settle = (checked: Exclude<Checked, { state: 'checking' }>) => {
      if (live) setResult({ key, checked });
    };
    verifyTee(tee, { registry: reader, examId }).then(
      ({ instancePublicKey }) => {
        verifyOutboxBuild(message, { examId, attestedInstancePublicKey: instancePublicKey as Hex }).then(
          (build) => {
            settle({ state: 'ready', build });
          },
          (error: unknown) => {
            settle({ state: 'blocked', reason: error instanceof OutboxError ? error.message : String(error) });
          },
        );
      },
      (error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        settle({ state: 'blocked', reason: `The sealed machine's proof is not trusted, so nothing it signed can be posted. ${why}` });
      },
    );
    return () => {
      live = false;
    };
    // The message is compared by its signature: each poll brings a new object with the same content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tee, reader, examId, key]);

  return result?.key === key ? result.checked : { state: 'checking' };
}

/** Step 6: the machine has finished. One action puts its signed record on the public record. */
export function BuildStep(props: { eyebrow: string; snapshot: Snapshot; onPosted: () => void }) {
  const { environment, addReceipt } = useBoardForm();
  const checked = useVerifiedBuild(props.snapshot);
  const build = checked.state === 'ready' ? checked.build : null;
  return (
    <Stage
      eyebrow={props.eyebrow}
      title="Record the sealed paper"
      lede="The sealed machine has built the paper. Posting its record lets anyone check that this is the paper centres receive."
      action={
        <>
          {checked.state === 'blocked' ? <Problem>{checked.reason}</Problem> : null}
          <PostAction
            label="Post to the public record"
            blocked={checked.state === 'checking' ? 'Checking the sealed machine’s signature.' : checked.state === 'blocked' ? 'This record cannot be posted.' : null}
            post={(onStage) => {
              if (!build) return Promise.reject(new Error('This Build has not been verified.'));
              return postBuildFlow(environment, build, onStage);
            }}
            onPosted={(outcome: PostOutcome) => {
              addReceipt({ kind: 'build', outcome });
              props.onPosted();
            }}
          />
        </>
      }
      next="Centres can then download the sealed paper. Nothing more is needed from you until exam day."
    >
      {build ? (
        <Rows>
          <Row label="Signature">
            <Check status="pass">From the sealed machine running the published code</Check>
          </Row>
          <Row label="Paper">
            {build.selected} questions, chosen from a bank of {build.bankSize}
          </Row>
        </Rows>
      ) : null}
      <ExamRecord snapshot={props.snapshot} />
    </Stage>
  );
}
