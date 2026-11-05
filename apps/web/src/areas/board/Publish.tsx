import { chain } from '@paperseal/protocol';
import { Badge, Button, Field, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { setCurrentExamId } from '../../shared/currentExam';
import { currentAccount, requestAccount, walletChainId } from '../../shared/wallet';
import { useBoardForm, useEvaluated } from './BoardForm';
import { evaluateSchedule, formatClock, whenTyped, type ScheduleResult } from './form';
import { explainError, publishExam, type PublishOutcome, type PublishRequest, type PublishStage } from './publishFlow';

const stageLabels: Record<PublishStage, string> = {
  checking: 'Checking the wallet, chain and board address.',
  simulating: 'Dry-running createExam.',
  wallet: 'Waiting for you to confirm in your wallet.',
  mining: 'Waiting for the transaction to be mined.',
  reading: 'Reading the exam back from ExamRegistry.',
};

type Progress =
  | { state: 'idle' }
  | { state: 'running'; stage: PublishStage }
  | { state: 'failed'; message: string }
  | { state: 'done'; outcome: PublishOutcome };

interface WalletState {
  account: string | null;
  chainId: number | null;
  board: string | null;
  error: string | null;
}

function WalletPanel(props: { wallet: WalletState; connected: boolean; onConnect: () => void }) {
  const { wallet } = props;
  const sameChain = wallet.chainId === chain.chainId;
  const isBoard = Boolean(wallet.account && wallet.board && wallet.account.toLowerCase() === wallet.board.toLowerCase());
  return (
    <Panel title="Board wallet">
      <Rows>
        <Row label="Account">{wallet.account ? <Mono>{wallet.account}</Mono> : 'Not connected.'}</Row>
        <Row label="Chain">
          {wallet.chainId === null ? (
            'Unknown.'
          ) : (
            <Badge tone={sameChain ? 'ok' : 'bad'}>
              {sameChain ? `Sepolia (${String(chain.chainId)})` : `Chain ${String(wallet.chainId)}, not Sepolia`}
            </Badge>
          )}
        </Row>
        <Row label="ExamRegistry board">{wallet.board ? <Mono>{wallet.board}</Mono> : 'Unknown.'}</Row>
        <Row label="Account is the board">
          {wallet.account && wallet.board ? (
            <Badge tone={isBoard ? 'ok' : 'bad'}>{isBoard ? 'Yes' : 'No'}</Badge>
          ) : (
            'Unknown.'
          )}
        </Row>
      </Rows>
      {wallet.error ? <Badge tone="bad">{wallet.error}</Badge> : null}
      <Button onClick={props.onConnect}>{props.connected ? 'Refresh wallet' : 'Connect wallet'}</Button>
    </Panel>
  );
}

function Summary(props: { request: PublishRequest; name: string; schedule: ScheduleResult; account: string | null; registry: string | null; blueprint: ReturnType<typeof useEvaluated>['blueprint'] }) {
  const { request, schedule, blueprint } = props;
  return (
    <Panel title="What will be written to ExamRegistry">
      <Rows>
        <Row label="Network">Sepolia, chain {chain.chainId}</Row>
        <Row label="ExamRegistry">{props.registry ? <Mono>{props.registry}</Mono> : 'Not set.'}</Row>
        <Row label="Sent from">{props.account ? <Mono>{props.account}</Mono> : 'Connect your wallet.'}</Row>
        <Row label="Exam name">{props.name}</Row>
        <Row label="Exam ID">
          <Mono>{request.examId}</Mono>
        </Row>
        <Row label="Commit hash">
          <Mono>{request.fields.commitHash}</Mono>
        </Row>
        <Row label="Image digest">
          <Mono>{request.fields.imageDigest}</Mono>
        </Row>
        <Row label="RPC operator host">
          <Mono>{request.fields.rpcHost}</Mono>
        </Row>
        <Row label="Exam start, T">
          {formatClock(request.schedule.examStart)} ({request.schedule.examStart})
        </Row>
        <Row label="Δ">{request.schedule.delta / 60} minutes ({request.schedule.delta} seconds)</Row>
        <Row label="Lock round">
          {request.schedule.lockRound}, at {schedule.lock ? formatClock(schedule.lock.producedAt) : ''}
        </Row>
        <Row label="Unlock round">
          {request.schedule.unlockRound}, at {schedule.unlock ? formatClock(schedule.unlock.producedAt) : ''}
        </Row>
        <Row label="End round">
          {request.schedule.endRound}, at {schedule.end ? formatClock(schedule.end.producedAt) : ''}
        </Row>
        {blueprint.criteria?.topics.map((topic) => (
          <Row key={topic.name} label={`Topic: ${topic.name}`}>
            {topic.questions} questions
          </Row>
        ))}
        <Row label="maxSetterPercent">{blueprint.criteria?.maxSetterPercent}</Row>
        <Row label="minBankMultiple">{blueprint.criteria?.minBankMultiple}</Row>
        <Row label="selectedCount">{blueprint.selectedCount}</Row>
        <Row label="criteriaHash">
          <Mono>{request.criteria.hash}</Mono>
        </Row>
      </Rows>
      <p>
        <strong>Everything above is written once and cannot be changed afterwards, not even by the board.</strong> That
        includes the drand rounds, the commit and the image digest. The criteria are published in full.
      </p>
    </Panel>
  );
}

export function Publish() {
  const { blueprint: blueprintInput, schedule: scheduleInput, publish, setPublish, environment } = useBoardForm();
  const evaluated = useEvaluated();
  const [wallet, setWallet] = useState<WalletState>({ account: null, chainId: null, board: null, error: null });
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<Progress>({ state: 'idle' });

  const refresh = useCallback(
    async (prompt: boolean) => {
      const provider = environment.getProvider();
      if (!provider) {
        setWallet({ account: null, chainId: null, board: null, error: 'No browser wallet was found in this browser.' });
        return;
      }
      try {
        const account = prompt ? await requestAccount(provider) : await currentAccount(provider);
        const chainId = await walletChainId(provider);
        const board = environment.createRegistry ? await environment.createRegistry().board() : null;
        setWallet({ account, chainId, board, error: null });
        setConnected(account !== null);
      } catch (error) {
        setWallet((previous) => ({ ...previous, error: explainError(error) }));
      }
    },
    [environment],
  );

  // A wallet that is already connected to this site shows without a prompt.
  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const { blueprint, schedule, publish: fieldsResult } = evaluated;
  const missing: { label: string; to: string }[] = [];
  if (!blueprint.criteria || !blueprint.examId) missing.push({ label: 'Complete the blueprint', to: '/board/blueprint' });
  if (!schedule.settings) missing.push({ label: 'Complete the schedule', to: '/board/schedule' });
  const ready = Boolean(blueprint.criteria && blueprint.examId && blueprint.encoded && blueprint.criteriaHash && schedule.settings && fieldsResult.fields);
  const request: PublishRequest | null =
    ready && blueprint.examId && blueprint.encoded && blueprint.criteriaHash && schedule.settings && fieldsResult.fields
      ? {
          examId: blueprint.examId,
          fields: fieldsResult.fields,
          schedule: schedule.settings,
          criteria: { encoded: blueprint.encoded, hash: blueprint.criteriaHash },
        }
      : null;

  async function confirm() {
    if (!request) return;
    // The lock time may have passed while this page was open.
    if (!evaluateSchedule(scheduleInput).settings) {
      setProgress({ state: 'failed', message: 'The schedule is no longer valid. Check the Schedule screen.' });
      return;
    }
    setProgress({ state: 'running', stage: 'checking' });
    try {
      const outcome = await publishExam(environment, request, (stage) => {
        setProgress({ state: 'running', stage });
      });
      setCurrentExamId(request.examId);
      setProgress({ state: 'done', outcome });
    } catch (error) {
      setProgress({ state: 'failed', message: explainError(error) });
    }
  }

  const busy = progress.state === 'running';
  return (
    <Screen title="Publish" lede="Write the exam to ExamRegistry on Sepolia. This happens once.">
      <WalletPanel
        wallet={wallet}
        connected={connected}
        onConnect={() => {
          void refresh(true);
        }}
      />
      <Panel title="What the TEE will run">
        <Field
          label="Commit hash"
          hint="The 40-character git SHA-1 of the tagged commit."
          error={whenTyped(publish.commitHash, fieldsResult.errors.commitHash)}
          value={publish.commitHash}
          onChange={(commitHash) => {
            setPublish({ ...publish, commitHash });
          }}
        />
        <Field
          label="Image digest"
          hint="The 64-character SHA-256 digest of the image, without the sha256: prefix."
          error={whenTyped(publish.imageDigest, fieldsResult.errors.imageDigest)}
          value={publish.imageDigest}
          onChange={(imageDigest) => {
            setPublish({ ...publish, imageDigest });
          }}
        />
        <Field
          label="RPC operator host"
          hint="The hostname the TEE reads the chain from, with no scheme, port or path."
          error={whenTyped(publish.rpcHost, fieldsResult.errors.rpcHost)}
          value={publish.rpcHost}
          onChange={(rpcHost) => {
            setPublish({ ...publish, rpcHost });
          }}
        />
      </Panel>
      {missing.length > 0 ? (
        <Panel title="Not ready to publish">
          <Rows>
            {missing.map(({ label, to }) => (
              <Row key={to} label={label}>
                <Link to={to}>Open</Link>
              </Row>
            ))}
          </Rows>
        </Panel>
      ) : null}
      {request ? (
        <Summary
          request={request}
          name={blueprintInput.name}
          schedule={schedule}
          account={wallet.account}
          registry={environment.registryAddress}
          blueprint={blueprint}
        />
      ) : null}
      {progress.state === 'running' ? <Panel title="Publishing">{stageLabels[progress.stage]}</Panel> : null}
      {progress.state === 'failed' ? <Panel title="Not published">{progress.message}</Panel> : null}
      {progress.state === 'done' ? (
        <Panel title={progress.outcome.matches ? 'Published and verified' : 'Published, but the read-back differs'}>
          <Rows>
            <Row label="Transaction">
              <Mono>{progress.outcome.transactionHash}</Mono>
            </Row>
            <Row label="Block">{String(progress.outcome.blockNumber)}</Row>
            {progress.outcome.rows.map((row) => (
              <Row key={row.label} label={row.label}>
                <Badge tone={row.match ? 'ok' : 'bad'}>{row.match ? 'Matches' : 'Differs'}</Badge>{' '}
                <Mono>{row.actual}</Mono>
                {row.match ? null : <> (entered: {row.expected})</>}
              </Row>
            ))}
          </Rows>
          <p>
            The exam is now the one shown in the <Link to="/board">overview</Link>.
          </p>
        </Panel>
      ) : null}
      <Button
        disabled={!request || busy || progress.state === 'done'}
        onClick={() => {
          void confirm();
        }}
      >
        Confirm and publish
      </Button>
    </Screen>
  );
}
