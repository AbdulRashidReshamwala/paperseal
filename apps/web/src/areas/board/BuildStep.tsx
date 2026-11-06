import type { Hex } from '@paperseal/protocol';
import { Check, Row, Rows, Stage } from '@paperseal/ui';
import { useEffect, useState } from 'react';

import { verifyTee } from '../../shared/attest';
import { useBoardForm, useReader } from './BoardForm';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { withDetails } from './details';
import { OutboxError, verifyOutboxBuild } from './outbox';
import { PostAction, Problem } from './Parts';
import { postBuildFlow, type BuildPost, type PostOutcome } from './postFlow';

type Checked = { state: 'checking' } | { state: 'ready'; build: BuildPost } | { state: 'blocked'; reason: string };

/**
 * Verifies the outbox message before the wallet can be asked: the TEE must attest for this exam,
 * and the Build must carry its signature under the attested key.
 */
function useVerifiedBuild(snapshot: Snapshot, examId: Hex): Checked {
  const { tee } = useBoardForm();
  const reader = useReader();
  const message = snapshot.outbox[0] ?? null;
  const signature = message?.teeSignature ?? '';
  const [result, setResult] = useState<{ key: string; checked: Exclude<Checked, { state: 'checking' }> } | null>(null);
  const key = `${examId}:${signature}`;

  useEffect(() => {
    if (!tee || !reader || !message) return;
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
            settle({ state: 'blocked', reason: withDetails('The paper’s record did not pass its check, so it cannot be posted. Contact whoever runs Paper Seal.', error instanceof OutboxError ? error.message : String(error)) });
          },
        );
      },
      (error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        settle({ state: 'blocked', reason: withDetails('Paper Seal could not be confirmed for this exam, so nothing was posted. Wait a minute and try again, or contact whoever runs Paper Seal.', why) });
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
export function BuildStep(props: { examId: Hex; snapshot: Snapshot; onPosted: () => void }) {
  const { environment, addReceipt } = useBoardForm();
  const checked = useVerifiedBuild(props.snapshot, props.examId);
  const build = checked.state === 'ready' ? checked.build : null;
  return (
    <Stage
      title="The paper is ready"
      lede="Post the paper’s record so that anyone can check it is the paper centres receive."
      action={
        <>
          {checked.state === 'blocked' ? <Problem>{checked.reason}</Problem> : null}
          <PostAction
            label="Post the paper’s record"
            blocked={checked.state === 'checking' ? 'Checking the paper’s record. This takes a moment.' : checked.state === 'blocked' ? 'This record cannot be posted. Contact whoever runs Paper Seal.' : null}
            post={(onStage) => {
              if (!build) return Promise.reject(new Error('The paper’s record has not been checked yet. Wait a moment and try again.'));
              return postBuildFlow(environment, build, onStage);
            }}
            onPosted={(outcome: PostOutcome) => {
              addReceipt({ kind: 'build', outcome });
              props.onPosted();
            }}
          />
        </>
      }
      next="Centres can then download the sealed paper. You have nothing else to do until the exam, and you can close this page."
    >
      {build ? (
        <Rows>
          <Row label="Record">
            <Check status="pass">Checked. It comes from Paper Seal for this exam.</Check>
          </Row>
          <Row label="Paper">
            {build.selected} questions, chosen from the {build.bankSize} sent in
          </Row>
        </Rows>
      ) : null}
      <ExamRecord snapshot={props.snapshot} />
    </Stage>
  );
}
