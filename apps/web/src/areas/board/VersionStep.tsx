import { Button, Check, Hash, PrimaryAction, Row, Rows, Stage } from '@paperseal/ui';

import { isRunUrlOf, type TeeReleasesError } from '../../shared/teeReleases';
import { withDetails } from './details';
import { Fold, Problem } from './Parts';
import type { Releases } from './releases';

function Unreachable(props: { error: TeeReleasesError; retry: () => void }) {
  return (
    <>
      <Problem>
        {props.error.kind === 'rate_limited'
          ? 'The versions could not be loaded because the service is busy. Wait a few minutes, then press Try again.'
          : 'The versions could not be loaded. Check your internet connection, then press Try again.'}
      </Problem>
      <div className="board-section">
        <Button onClick={props.retry}>Try again</Button>
      </div>
    </>
  );
}

/** Step 2: the newest version that checks out is already selected, so this is one click. */
export function VersionStep(props: {
  eyebrow: string;
  releases: Releases;
  chosen: string;
  onChoose: (version: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { releases, chosen } = props;
  const { list, selected, status, verified, mismatched, repo } = releases;
  const hasReleases = list.state === 'ready' && list.releases.length > 0;
  const lede =
    list.state === 'loading'
      ? 'Loading the available versions.'
      : list.state === 'ready' && list.releases.length === 0
        ? 'There is no version to use yet. Ask whoever looks after Paper Seal to publish one, then come back.'
        : verified
          ? `Version ${verified.version} is ${chosen ? 'the version you chose' : 'the newest version'}. It has been checked and is ready to use.`
          : status?.state === 'checking'
            ? `Checking version ${selected?.version ?? ''}.`
            : 'No version can be used yet. Try again in a few minutes, or ask whoever looks after Paper Seal.';
  return (
    <Stage
      eyebrow={props.eyebrow}
      title="Choose the Paper Seal version"
      lede={lede}
      action={
        <>
          {list.state === 'failed' ? <Unreachable error={list.error} retry={releases.retry} /> : null}
          {status?.state === 'failed' ? <Unreachable error={status.error} retry={releases.retry} /> : null}
          {mismatched.map(({ release, tagCommit }) => (
            <Problem key={release.version}>
              {withDetails(
                `Version ${release.version} did not pass its check, so it cannot be used. Choose another version.`,
                `The tag points at commit ${tagCommit}, but the release notes say ${release.commit.slice(2)}.`,
              )}
            </Problem>
          ))}
          {hasReleases && !selected ? <Problem>No version passed its check, so the exam cannot be published yet. Try again in a few minutes, or ask whoever looks after Paper Seal.</Problem> : null}
          <PrimaryAction disabled={!verified} onClick={props.onContinue}>
            {verified ? `Use ${verified.version}` : 'Use this version'}
          </PrimaryAction>
        </>
      }
      next="You review the whole exam before anything is published."
    >
      {hasReleases ? (
        <Fold summary="Use a different version">
          <label className="ps-field">
            <span>Version</span>
            <select
              className="ps-input"
              value={chosen}
              onChange={(event) => {
                props.onChoose(event.target.value);
              }}
            >
              <option value="">Newest checked version</option>
              {list.releases.map((release) => (
                <option key={release.version} value={release.version}>
                  {release.version}
                </option>
              ))}
            </select>
          </label>
        </Fold>
      ) : null}
      {selected ? (
        <Fold summary="Version details">
          <Rows>
            <Row label="Version">{selected.version}</Row>
            <Row label="Commit">
              <Hash value={selected.commit} label="commit" />
            </Row>
            <Row label="Image digest">
              <Hash value={selected.imageDigest} label="image digest" />
            </Row>
            <Row label="Tag check">
              {status?.state === 'verified' ? <Check status="pass">The tag points at this commit</Check> : <Check status="pending" />}
            </Row>
            <Row label="Release page">
              {isRunUrlOf(selected.run, repo) ? (
                <a href={selected.run} target="_blank" rel="noreferrer">
                  {selected.run}
                </a>
              ) : (
                <>
                  <Check status="not-checked">This is not a run of {repo}, so it is not linked.</Check> <span className="ps-mono">{selected.run}</span>
                </>
              )}
            </Row>
          </Rows>
        </Fold>
      ) : null}
      <p className="board-quiet">
        <Button onClick={props.onBack}>Back</Button>
      </p>
    </Stage>
  );
}
