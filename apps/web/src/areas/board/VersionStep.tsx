import { Button, Check, Hash, PrimaryAction, Row, Rows, Stage } from '@paperseal/ui';

import { isRunUrlOf, type TeeReleasesError } from '../../shared/teeReleases';
import { Fold, Problem } from './Parts';
import type { Releases } from './releases';

function Unreachable(props: { error: TeeReleasesError; retry: () => void }) {
  return (
    <>
      <Problem>
        {props.error.kind === 'rate_limited'
          ? 'GitHub is limiting requests from this browser, so the versions could not be checked. Publishing is blocked until GitHub answers.'
          : 'GitHub could not be reached, so the versions could not be checked. Publishing is blocked until GitHub answers.'}
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
      ? 'Loading the published versions from GitHub.'
      : list.state === 'ready' && list.releases.length === 0
        ? 'There are no versions yet. A version must be tagged first: push a tag like v1.0.0 and wait for the build workflow to publish its release.'
        : verified
          ? `${verified.version} is ${chosen ? 'the version you chose' : 'the newest published version'}, and its tag points at the commit its release names.`
          : status?.state === 'checking'
            ? `Checking that the tag ${selected?.version ?? ''} points at the commit its release names.`
            : 'No version can be used yet.';
  return (
    <Stage
      eyebrow={props.eyebrow}
      title="Choose what the sealed machine runs"
      lede={lede}
      action={
        <>
          {list.state === 'failed' ? <Unreachable error={list.error} retry={releases.retry} /> : null}
          {status?.state === 'failed' ? <Unreachable error={status.error} retry={releases.retry} /> : null}
          {mismatched.map(({ release, tagCommit }) => (
            <Problem key={release.version}>
              {`Release mismatch: the tag ${release.version} points at commit ${tagCommit}, but the release notes say ${release.commit.slice(2)}. Do not use this version.`}
            </Problem>
          ))}
          {hasReleases && !selected ? <Problem>Publishing is blocked, because no version matches its tag.</Problem> : null}
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
              <option value="">Newest that checks out</option>
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
        <Fold summary="Exam record">
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
            <Row label="Build run">
              {isRunUrlOf(selected.run, repo) ? (
                <a href={selected.run} target="_blank" rel="noreferrer">
                  {selected.run}
                </a>
              ) : (
                <>
                  <Check status="not-checked">Not a workflow run of {repo}, so it is not linked.</Check> <span className="ps-mono">{selected.run}</span>
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
