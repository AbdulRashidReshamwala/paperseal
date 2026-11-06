import { Button, Check, Row } from '@paperseal/ui';

import { isRunUrlOf, type TeeReleasesError } from '../../shared/teeReleases';
import { withDetails } from './details';
import { Fold, Problem } from './Parts';
import type { Releases } from './releases';

/*
 * The Paper Seal version is part of the review, not a step of its own. The newest version that
 * checks out is already chosen, so most boards never open the picker. A version that can't be
 * checked, or fails its check, is explained here and keeps the exam from being published.
 */

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

/** What the review row says about the version, in one sentence. */
export function versionSummary(releases: Releases, chosen: string): string {
  const { list, selected, status, verified } = releases;
  if (list.state === 'loading') return 'Loading the available versions.';
  if (list.state === 'ready' && list.releases.length === 0) {
    return 'There is no version to use yet. Ask whoever looks after Paper Seal to publish one, then come back.';
  }
  if (verified) return `${verified.version}, ${chosen ? 'the version you chose' : 'the newest version'}. It has been checked.`;
  if (status?.state === 'checking') return `Checking version ${selected?.version ?? ''}.`;
  return 'No version can be used yet.';
}

/** Why no version can be used, with what to do. Empty while everything is fine. */
export function VersionProblems(props: { releases: Releases }) {
  const { list, selected, status, mismatched } = props.releases;
  const hasReleases = list.state === 'ready' && list.releases.length > 0;
  return (
    <>
      {list.state === 'failed' ? <Unreachable error={list.error} retry={props.releases.retry} /> : null}
      {status?.state === 'failed' ? <Unreachable error={status.error} retry={props.releases.retry} /> : null}
      {mismatched.map(({ release, tagCommit }) => (
        <Problem key={release.version}>
          {withDetails(
            `Version ${release.version} did not pass its check, so it cannot be used. Choose another version.`,
            `The tag points at commit ${tagCommit}, but the release notes say ${release.commit.slice(2)}.`,
          )}
        </Problem>
      ))}
      {hasReleases && !selected ? (
        <Problem>No version passed its check, so the exam cannot be published yet. Try again in a few minutes, or ask whoever looks after Paper Seal.</Problem>
      ) : null}
    </>
  );
}

/** The folded choice of another version. */
export function VersionPicker(props: { releases: Releases; chosen: string; onChoose: (version: string) => void }) {
  const { list } = props.releases;
  const hasReleases = list.state === 'ready' && list.releases.length > 0;
  return (
    <>
      {hasReleases ? (
        <Fold summary="Use a different version">
          <label className="ps-field">
            <span>Version</span>
            <select
              className="ps-input"
              value={props.chosen}
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
    </>
  );
}

/** The evidence for the version in use, for the folded exam record. */
export function VersionEvidence(props: { releases: Releases }) {
  const { selected, status, repo } = props.releases;
  if (!selected) return null;
  return (
    <>
      <Row label="Check">
        {status?.state === 'verified' ? <Check status="pass">This version matches its published release</Check> : <Check status="pending" />}
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
    </>
  );
}
