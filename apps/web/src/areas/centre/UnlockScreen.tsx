import { timelockDecrypt } from '@paperseal/crypto';
import { fromHex, toHex, type Paper } from '@paperseal/protocol';
import { Badge, Button, EmptyState, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useMemo, useState } from 'react';

import { storageUrl } from '../../shared/config';
import { holderCredential, listEntryFor } from '../../shared/holder';
import { browserKeys } from '../../shared/Register';
import { examId, registry } from '../../shared/registry';
import { storageFetcher } from '../../shared/storage';
import { TeeStatus } from '../../shared/TeeStatus';
import { useCentreState } from './CentreState';
import { downloadPaperFiles } from './download';
import { chainReaders } from './readers';
import { unlockPaper, unlockStepLabels, unlockSteps, type UnlockStep } from './unlock';

type Progress =
  | { state: 'idle' }
  | { state: 'running'; step: UnlockStep }
  | { state: 'failed'; step: UnlockStep | null; message: string };

/** The paper, grouped by topic in the order each topic first appears. Held in memory only. */
export function PaperView(props: { paper: Paper }) {
  const topics = [...new Set(props.paper.questions.map((question) => question.topic))];
  return (
    <>
      {topics.map((topic) => (
        <Panel key={topic} title={topic}>
          <ol>
            {props.paper.questions
              .filter((question) => question.topic === topic)
              .map((question, index) => (
                <li key={index}>{question.text}</li>
              ))}
          </ol>
        </Panel>
      ))}
    </>
  );
}

export function Unlock() {
  const { downloaded, setDownloaded } = useCentreState();
  const identity = useMemo(() => holderCredential(), []);
  const [progress, setProgress] = useState<Progress>({ state: 'idle' });
  const [paper, setPaper] = useState<Paper | null>(null);
  const ready = registry !== null && examId !== null && storageUrl !== null && identity !== null;

  async function start() {
    if (!registry || !examId || !storageUrl || !identity) return;
    let current: UnlockStep | null = null;
    setProgress({ state: 'running', step: 'timelock' });
    try {
      const own = await listEntryFor(registry, examId, identity.passkeyPublicKey);
      if (!own || own.derivedPublicKey.length === 0) throw new Error('Your security key is not an approved centre on the on-chain list.');
      const fetchFile = storageFetcher(storageUrl, examId);
      const readers = chainReaders(registry, examId);
      const build = await readers.readBuild();
      if (!build) throw new Error('No paper has been committed on-chain yet.');
      const files =
        downloaded ??
        (await downloadPaperFiles({ examId, fetchFile, readBuild: readers.readBuild, readListEntries: readers.readListEntries }));
      setDownloaded(files);
      const shown = await unlockPaper({
        examId,
        credentialId: fromHex(identity.credentialId),
        derivedPublicKey: toHex(own.derivedPublicKey),
        keys: browserKeys(),
        build,
        criteria: await readers.readCriteria(),
        paperFile: files.paper,
        keyPubTlock: files.keyPubTlock,
        timelockDecrypt: (ciphertext) => timelockDecrypt(ciphertext),
        fetchFile,
        onStep: (step) => {
          current = step;
          setProgress({ state: 'running', step });
        },
      });
      setPaper(shown);
      setProgress({ state: 'idle' });
    } catch (error) {
      setPaper(null);
      setProgress({ state: 'failed', step: current, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const running = progress.state === 'running';
  return (
    <Screen title="Unlock" lede="Touch your security key to open the paper once K_priv arrives.">
      <TeeStatus />
      {paper ? (
        <>
          <Panel title="Paper unlocked">
            Checked against the salted paper hash in the Build. It is held in this page only and is gone on reload.
          </Panel>
          <PaperView paper={paper} />
        </>
      ) : (
        <EmptyState title="Paper locked">
          {ready
            ? 'Unlock needs the time seal to have opened and the TEE to have delivered your copy of K_priv.'
            : 'Unlock needs a registered security key, the chain, the exam and public storage to be configured.'}
        </EmptyState>
      )}
      <Panel title="Steps">
        <Rows>
          {unlockSteps.map((step) => (
            <Row key={step} label={unlockStepLabels[step]}>
              {progress.state === 'running' && progress.step === step ? <Badge tone="warn">In progress</Badge> : null}
              {progress.state === 'failed' && progress.step === step ? <Badge tone="bad">Failed</Badge> : null}
            </Row>
          ))}
        </Rows>
      </Panel>
      {progress.state === 'failed' ? <Panel title="Unlock failed">{progress.message}</Panel> : null}
      <Button disabled={!ready || running || paper !== null} onClick={() => void start()}>
        Unlock paper
      </Button>
    </Screen>
  );
}
