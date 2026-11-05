import { Badge, Button, Connected, EmptyState, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useState } from 'react';

import { storageUrl } from '../../shared/config';
import { examId, fromExam, notConnectedToChain, registry } from '../../shared/registry';
import { storageFetcher } from '../../shared/storage';
import { useCentreState } from './CentreState';
import { downloadPaperFiles } from './download';
import { chainReaders } from './readers';

const loadBuild = fromExam((client, id) => client.getBuild(id));

type Progress = { state: 'idle' } | { state: 'running' } | { state: 'failed'; message: string };

export function Download() {
  const { downloaded, setDownloaded } = useCentreState();
  const [progress, setProgress] = useState<Progress>({ state: 'idle' });
  const ready = registry !== null && examId !== null && storageUrl !== null;

  async function start() {
    if (!registry || !examId || !storageUrl) return;
    setProgress({ state: 'running' });
    try {
      const readers = chainReaders(registry, examId);
      setDownloaded(
        await downloadPaperFiles({
          examId,
          fetchFile: storageFetcher(storageUrl, examId),
          readBuild: readers.readBuild,
          readListEntries: readers.readListEntries,
        }),
      );
      setProgress({ state: 'idle' });
    } catch (error) {
      setDownloaded(null);
      setProgress({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <Screen title="Download" lede="Fetch the encrypted paper ahead of the exam and check it against the Build.">
      <Connected title="Committed paper" notConnected={notConnectedToChain} load={loadBuild}>
        {(build) =>
          build ? (
            <Rows>
              <Row label="Paper hash">
                <Mono>{build.paperHash}</Mono>
              </Row>
              <Row label="Manifest hash">
                <Mono>{build.storageManifestHash}</Mono>
              </Row>
            </Rows>
          ) : (
            'No paper has been committed yet.'
          )
        }
      </Connected>
      {progress.state === 'failed' ? <Panel title="Download failed">{progress.message}</Panel> : null}
      {downloaded ? (
        <Panel title="Downloaded and checked">
          <Rows>
            {downloaded.checks.map((check) => (
              <Row key={check.label} label={check.label}>
                <Badge tone="ok">{check.detail}</Badge>
              </Row>
            ))}
            <Row label="paper.bin size">{downloaded.paper.length} bytes</Row>
          </Rows>
        </Panel>
      ) : (
        <EmptyState title="Nothing downloaded">
          {ready
            ? 'Download paper.bin, key-pub.tlock and the manifest. Each hash is checked against the Build on-chain.'
            : 'Set VITE_STORAGE_URL, VITE_RPC_URL, VITE_REGISTRY_ADDRESS and VITE_EXAM_ID to download.'}
        </EmptyState>
      )}
      <Button disabled={!ready || progress.state === 'running'} onClick={() => void start()}>
        {downloaded ? 'Download again' : 'Download and check'}
      </Button>
    </Screen>
  );
}
