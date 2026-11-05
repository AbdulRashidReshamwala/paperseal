import type { OutboxMessage } from '@paperseal/tee-client';
import { Badge, Connected, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useMemo } from 'react';

import { verifyTee } from '../../shared/attest';
import { useCurrentExamId } from '../../shared/currentExam';
import { tee } from '../../shared/tee';
import { useBoardForm, useReader } from './BoardForm';
import { OutboxError, verifyOutboxBuild } from './outbox';
import { postBuildFlow, type BuildPost } from './postFlow';
import { PostPanel } from './PostPanel';

interface Checked {
  message: OutboxMessage;
  build: BuildPost | null;
  /** Why the message cannot be posted, in words. */
  problem: string | null;
}

interface Loaded {
  attestation: { trusted: true } | { trusted: false; reason: string };
  messages: Checked[];
}

function BuildMessage(props: { checked: Checked }) {
  const { environment } = useBoardForm();
  const { checked } = props;
  const { build } = checked;
  return (
    <Panel title={`Build for ${checked.message.examId}`}>
      <Rows>
        <Row label="TEE signature">
          {checked.problem ? <Badge tone="bad">Not verified</Badge> : <Badge tone="ok">Verifies under the attested instance key</Badge>}
        </Row>
        {Object.entries(checked.message.fields).map(([name, value]) => (
          <Row key={name} label={name}>
            <Mono>{String(value)}</Mono>
          </Row>
        ))}
        <Row label="Instance public key">
          <Mono>{checked.message.instancePublicKey}</Mono>
        </Row>
      </Rows>
      <PostPanel
        title="Post the Build"
        label="Post Build"
        blocked={checked.problem}
        post={(onStage) => {
          if (!build) return Promise.reject(new Error('This Build has not been verified.'));
          return postBuildFlow(environment, build, onStage);
        }}
      />
    </Panel>
  );
}

export function Outbox() {
  const reader = useReader();
  const examId = useCurrentExamId();
  const load = useMemo(() => {
    if (!tee || !reader || !examId) return null;
    const client = tee;
    return async (): Promise<Loaded> => {
      const { messages } = await client.outbox();
      let attested: string | null = null;
      let attestation: Loaded['attestation'];
      try {
        attested = (await verifyTee(client, { registry: reader, examId })).instancePublicKey;
        attestation = { trusted: true };
      } catch (error) {
        attestation = { trusted: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const checked = await Promise.all(
        messages.map(async (message): Promise<Checked> => {
          if (attested === null) {
            return { message, build: null, problem: 'The TEE attestation is not trusted, so nothing it signed can be posted.' };
          }
          try {
            return { message, build: await verifyOutboxBuild(message, { examId, attestedInstancePublicKey: attested as `0x${string}` }), problem: null };
          } catch (error) {
            if (error instanceof OutboxError) return { message, build: null, problem: error.message };
            throw error;
          }
        }),
      );
      return { attestation, messages: checked };
    };
  }, [reader, examId]);

  return (
    <Screen title="Outbox" lede="TEE-signed messages waiting for the board wallet to post.">
      <Connected
        title="Outbox"
        notConnected="Set VITE_TEE_URL, VITE_RPC_URL and VITE_REGISTRY_ADDRESS, and select an exam, to read the outbox."
        load={load}
      >
        {(loaded) => (
          <>
            <Rows>
              <Row label="TEE attestation">
                {loaded.attestation.trusted ? <Badge tone="ok">Trusted</Badge> : <Badge tone="bad">{loaded.attestation.reason}</Badge>}
              </Row>
            </Rows>
            {loaded.messages.length === 0
              ? 'Nothing waiting to post.'
              : loaded.messages.map((checked) => <BuildMessage key={`${checked.message.kind}-${checked.message.teeSignature}`} checked={checked} />)}
          </>
        )}
      </Connected>
    </Screen>
  );
}
