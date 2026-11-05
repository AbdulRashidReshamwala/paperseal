import { Badge, Button, Mono, Panel, Row, Rows } from '@paperseal/ui';
import { useState } from 'react';

import { requestAccount } from '../../shared/wallet';
import { useBoardForm } from './BoardForm';
import { postStageLabels, type PostOutcome, type PostStage } from './postFlow';
import { explainError } from './publishFlow';

type Progress =
  | { state: 'idle' }
  | { state: 'running'; stage: PostStage }
  | { state: 'failed'; message: string }
  | { state: 'done'; outcome: PostOutcome };

/**
 * The wallet and post button shared by the approved list and the Build. `blocked` says why posting
 * is not allowed yet, in words. The flow itself rechecks the wallet, chain and board address.
 */
export function PostPanel(props: {
  title: string;
  /** Sends the post. It reports its stages and resolves with the read-back. */
  post: (onStage: (stage: PostStage) => void) => Promise<PostOutcome>;
  blocked: string | null;
  label: string;
}) {
  const { environment } = useBoardForm();
  const [account, setAccount] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>({ state: 'idle' });

  async function connect() {
    const provider = environment.getProvider();
    if (!provider) {
      setWalletError('No browser wallet was found. Install one in this Chromium browser and reload.');
      return;
    }
    try {
      setAccount(await requestAccount(provider));
      setWalletError(null);
    } catch (error) {
      setWalletError(explainError(error));
    }
  }

  async function send() {
    setProgress({ state: 'running', stage: 'checking' });
    try {
      const outcome = await props.post((stage) => {
        setProgress({ state: 'running', stage });
      });
      setProgress({ state: 'done', outcome });
    } catch (error) {
      setProgress({ state: 'failed', message: explainError(error) });
    }
  }

  const running = progress.state === 'running';
  return (
    <Panel title={props.title}>
      <Rows>
        <Row label="Wallet account">{account ? <Mono>{account}</Mono> : 'Not connected.'}</Row>
      </Rows>
      {walletError ? <Badge tone="bad">{walletError}</Badge> : null}
      {props.blocked ? <Badge tone="warn">{props.blocked}</Badge> : null}
      {progress.state === 'running' ? <p>{postStageLabels[progress.stage]}</p> : null}
      {progress.state === 'failed' ? <Badge tone="bad">{progress.message}</Badge> : null}
      {progress.state === 'done' ? (
        <>
          <Badge tone={progress.outcome.matches ? 'ok' : 'bad'}>
            {progress.outcome.matches ? 'Posted, and ExamRegistry returns what was sent.' : 'Posted, but ExamRegistry returns something different.'}
          </Badge>
          <Rows>
            <Row label="Transaction">
              <Mono>{progress.outcome.transactionHash}</Mono>
            </Row>
            <Row label="Block">{String(progress.outcome.blockNumber)}</Row>
            {progress.outcome.rows.map((row) => (
              <Row key={row.label} label={row.label}>
                <Badge tone={row.match ? 'ok' : 'bad'}>{row.match ? 'Matches' : `Expected ${row.expected}, read ${row.actual}`}</Badge>
              </Row>
            ))}
          </Rows>
        </>
      ) : null}
      <Button onClick={() => void connect()}>{account ? 'Refresh wallet' : 'Connect wallet'}</Button>{' '}
      <Button disabled={running || props.blocked !== null || progress.state === 'done'} onClick={() => void send()}>
        {props.label}
      </Button>
    </Panel>
  );
}
