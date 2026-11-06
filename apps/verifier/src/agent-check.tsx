import { Button, CopyButton } from '@paperseal/ui';

import { agentPrompt } from './agent-prompt';
import { REPOSITORY } from './custody';
import { releaseTag } from './env';
import { shareUrl } from './link';

/**
 * The share link for an exam (spec/agent-verification.md, "Share Links"): this page's address with
 * its hash dropped and `?exam=<id>`, whichever form (a name, a hash, a query) the page was opened with.
 */
export function examShareUrl(href: string, examId: string): string | null {
  try {
    const url = new URL(href);
    url.hash = `#/exam/${examId}`;
    return shareUrl(url.href);
  } catch {
    return null;
  }
}

const currentHref = () => (globalThis.location as Location | undefined)?.href ?? '';

/**
 * "Check with your own AI": copies a prompt built here, in the browser, from the settings this page
 * is using. Nothing is sent anywhere. Disabled, with the reason, until every field is valid.
 */
export function AgentCheck(props: { examId: string | null; registry: string; storageUrl: string; version?: string; href?: string }) {
  const examId = props.examId ?? '';
  const prompt = agentPrompt({
    examId,
    registry: props.registry,
    storageUrl: props.storageUrl,
    verifierUrl: examShareUrl(props.href ?? currentHref(), examId) ?? '',
    repository: REPOSITORY,
    version: props.version ?? releaseTag,
  });
  const label = 'Check with your own AI';
  return (
    <div className="ps-stage-action vf-agent">
      <div className="vf-agent-row">
        {prompt.ok ? (
          <CopyButton key={prompt.text} text={prompt.text} copied="Copied. Paste it into any AI agent.">
            {label}
          </CopyButton>
        ) : (
          <Button disabled>{label}</Button>
        )}
        <span className="vf-agent-repo">
          Repository{' '}
          <a href={`https://github.com/${REPOSITORY}`} target="_blank" rel="noreferrer">
            github.com/{REPOSITORY}
          </a>
        </span>
      </div>
      {prompt.ok ? (
        <details className="vf-agent-text">
          <summary>Show the text</summary>
          <pre className="vf-code">{prompt.text}</pre>
        </details>
      ) : (
        <p className="vf-agent-reason">{prompt.reason}</p>
      )}
    </div>
  );
}
