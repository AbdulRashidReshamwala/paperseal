import { chain } from '@paperseal/protocol';
import { Badge, Button, Field, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { setCurrentExamId } from '../../shared/currentExam';
import { currentAccount, requestAccount, walletChainId } from '../../shared/wallet';
import { useBoardForm, useEvaluated } from './BoardForm';
import { checkTag, fetchReleases, releasesRepo, TeeReleasesError, type TeeRelease } from '../../shared/teeReleases';
import { evaluatePublish, evaluateSchedule, formatClock, whenTyped, type ScheduleResult } from './form';
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
  | { state: 'done'; outcome: PublishOutcome; version: string };

interface WalletState {
  account: string | null;
  chainId: number | null;
  board: string | null;
  error: string | null;
}

type ReleaseList =
  | { state: 'loading' }
  | { state: 'failed'; error: TeeReleasesError }
  | { state: 'ready'; releases: TeeRelease[] };

type TagStatus =
  | { state: 'checking' }
  | { state: 'verified' }
  | { state: 'mismatch'; tagCommit: string }
  | { state: 'failed'; error: TeeReleasesError };

const asReleasesError = (error: unknown): TeeReleasesError =>
  error instanceof TeeReleasesError ? error : new TeeReleasesError('unreachable', 'GitHub could not be reached.');

function useReleases(version: string) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ attempt: number; list: Exclude<ReleaseList, { state: 'loading' }> } | null>(null);
  const [checked, setChecked] = useState<{ key: string; status: Exclude<TagStatus, { state: 'checking' }> } | null>(null);
  const repo = useMemo(() => releasesRepo(), []);

  useEffect(() => {
    let current = true;
    fetchReleases(repo).then(
      (releases) => {
        if (current) setLoaded({ attempt, list: { state: 'ready', releases } });
      },
      (error: unknown) => {
        if (current) setLoaded({ attempt, list: { state: 'failed', error: asReleasesError(error) } });
      },
    );
    return () => {
      current = false;
    };
  }, [repo, attempt]);

  const list: ReleaseList = loaded?.attempt === attempt ? loaded.list : { state: 'loading' };
  const selected = list.state === 'ready' ? (list.releases.find((r) => r.version === version) ?? null) : null;
  const key = selected ? `${String(attempt)}:${selected.version}` : '';
  useEffect(() => {
    if (!selected) return;
    let current = true;
    checkTag(repo, selected).then(
      (result) => {
        if (!current) return;
        setChecked({
          key,
          status: result.kind === 'verified' ? { state: 'verified' } : { state: 'mismatch', tagCommit: result.tagCommit },
        });
      },
      (error: unknown) => {
        if (current) setChecked({ key, status: { state: 'failed', error: asReleasesError(error) } });
      },
    );
    return () => {
      current = false;
    };
  }, [repo, selected, key]);

  const status: TagStatus | null = selected ? (checked?.key === key ? checked.status : { state: 'checking' }) : null;
  return {
    list,
    selected,
    status,
    /** Only a release whose commit matches its tag. */
    verified: selected && status?.state === 'verified' ? selected : null,
    retry: () => {
      setAttempt((n) => n + 1);
    },
  };
}

function ReleasePanel(props: { releases: ReturnType<typeof useReleases>; version: string; onSelect: (version: string) => void }) {
  const { list, selected, status } = props.releases;
  const unreachable = (error: TeeReleasesError) => (
    <>
      <Badge tone="bad">
        {error.kind === 'rate_limited'
          ? 'GitHub is limiting requests from this browser, so the versions could not be checked.'
          : 'GitHub could not be reached, so the versions could not be checked.'}
      </Badge>
      <p>Publishing is blocked until GitHub answers. Wait a moment and try again.</p>
      <Button onClick={props.releases.retry}>Try again</Button>
    </>
  );
  return (
    <Panel title="What the TEE will run">
      {list.state === 'loading' ? <p>Loading the TEE versions from GitHub.</p> : null}
      {list.state === 'failed' ? unreachable(list.error) : null}
      {list.state === 'ready' && list.releases.length === 0 ? (
        <p>
          There are no TEE versions yet. A version must be tagged first: push a tag like v1.0.0 and wait for the build
          workflow to publish its release.
        </p>
      ) : null}
      {list.state === 'ready' && list.releases.length > 0 ? (
        <label className="ps-field">
          <span>TEE version</span>
          <select
            value={props.version}
            onChange={(event) => {
              props.onSelect(event.target.value);
            }}
          >
            <option value="">Select a version</option>
            {list.releases.map((release) => (
              <option key={release.version} value={release.version}>
                {release.version}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {selected ? (
        <Rows>
          <Row label="Commit hash">
            <Mono>{selected.commit}</Mono>
          </Row>
          <Row label="Image digest">
            <Mono>{selected.imageDigest}</Mono>
          </Row>
          <Row label="Build run">
            <a href={selected.run} target="_blank" rel="noreferrer">
              {selected.run}
            </a>
          </Row>
        </Rows>
      ) : null}
      {status?.state === 'checking' ? <p>Checking that the tag points at this commit.</p> : null}
      {status?.state === 'verified' ? <Badge tone="ok">The tag {selected?.version} points at this commit.</Badge> : null}
      {status?.state === 'mismatch' ? (
        <>
          <Badge tone="bad">
            Release mismatch: the tag {selected?.version} points at commit {status.tagCommit}, but the release notes say{' '}
            {selected?.commit.slice(2)}.
          </Badge>
          <p>Publishing is blocked. Do not use this version; choose another.</p>
        </>
      ) : null}
      {status?.state === 'failed' ? unreachable(status.error) : null}
    </Panel>
  );
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
        <Row label="TEE version">
          {request.fields.version} (not stored on-chain; only the commit hash and image digest below are)
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
        includes the drand rounds, the commit and the image digest. The version name is only a label for them. The criteria are published in full.
      </p>
    </Panel>
  );
}

export function Publish() {
  const { blueprint: blueprintInput, schedule: scheduleInput, publish, setPublish, environment } = useBoardForm();
  const evaluated = useEvaluated();
  const releases = useReleases(publish.version);
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

  const { blueprint, schedule } = evaluated;
  const fieldsResult = evaluatePublish(publish, releases.verified);
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
      setProgress({ state: 'done', outcome, version: request.fields.version });
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
      <ReleasePanel
        releases={releases}
        version={publish.version}
        onSelect={(version) => {
          setPublish({ ...publish, version });
        }}
      />
      <Panel title="Where the TEE reads the chain">
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
            <Row label="TEE version">
              {progress.version} (the release you selected; the version is not stored on-chain, only its commit hash and image digest)
            </Row>
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
