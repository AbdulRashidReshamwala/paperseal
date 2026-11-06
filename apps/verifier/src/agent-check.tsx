import { CopyButton } from '@paperseal/ui';

import { agentPrompt, type PromptResult } from './agent-prompt';
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

/** The prompt for "Check with your own AI", built here, in the browser, from the settings this page is using. */
export function agentCheckPrompt(props: { examId: string | null; registry: string; storageUrl: string; version?: string; href?: string }): PromptResult {
  const examId = props.examId ?? '';
  return agentPrompt({
    examId,
    registry: props.registry,
    storageUrl: props.storageUrl,
    verifierUrl: examShareUrl(props.href ?? currentHref(), examId) ?? '',
    repository: REPOSITORY,
    version: props.version ?? releaseTag,
  });
}

/**
 * "Check with your own AI": copies a prompt that is ready to run. Nothing is sent anywhere. The page
 * shows it only when every field is valid, because a disabled button in the headline's place helps no one.
 */
export function AgentCheck({ prompt }: { prompt: string }) {
  return (
    <div className="vf-agent">
      <div className="vf-agent-row">
        <CopyButton key={prompt} text={prompt} copied="Copied. Paste it into any AI agent.">
          Check with your own AI
        </CopyButton>
        <span className="vf-agent-repo">
          Repository{' '}
          <a href={`https://github.com/${REPOSITORY}`} target="_blank" rel="noreferrer">
            github.com/{REPOSITORY}
          </a>
        </span>
      </div>
      <details className="vf-agent-text">
        <summary>Show the text</summary>
        <pre className="vf-code">{prompt}</pre>
      </details>
    </div>
  );
}
