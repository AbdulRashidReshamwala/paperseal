import { looksLikeEnsName, type Hex } from '@paperseal/protocol';
import { Button, LoadingSeal, Page, RoleHeader, Stage } from '@paperseal/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { setCurrentExamId, useCurrentExamId } from './currentExam';
import { checkExamName, examNameInPath, shortExamId, verifiedIdOf, verifiedNameOf, verifyExamHint } from './examName';
import { nameLookup } from './names';
import { registryAddress } from './registry';

type LinkCheck = { state: 'checking' } | { state: 'open' } | { state: 'refused'; retry: boolean };

/** Points this browser at the exam `name` opens, once it passes. Null without a name. */
export function useLinkedName(name: string | null) {
  const [checked, setChecked] = useState<{ name: string; check: LinkCheck } | null>(null);
  const [round, setRound] = useState(0);
  const known = name ? verifiedIdOf(name) : null;
  useEffect(() => {
    if (!name) return;
    if (known) {
      setCurrentExamId(known);
      return;
    }
    let live = true;
    void checkExamName(nameLookup, registryAddress, name).then((result) => {
      if (result.ok) setCurrentExamId(result.examId);
      if (live) setChecked({ name, check: result.ok ? { state: 'open' } : { state: 'refused', retry: result.retry } });
    });
    return () => {
      live = false;
    };
  }, [known, name, round]);
  if (!name) return null;
  return {
    check: known ? ({ state: 'open' } as const) : checked?.name === name ? checked.check : ({ state: 'checking' } as const),
    retry: () => {
      setChecked(null);
      setRound((n) => n + 1);
    },
  };
}

/** A name that did not pass. Nothing of any exam shows behind it. */
export function NameRefused(props: { role: string; retry: boolean; onRetry: () => void }) {
  return (
    <Page header={<RoleHeader role={props.role} />}>
      <Stage
        title="This exam could not be opened"
        lede={props.retry ? 'The name cannot be checked right now. Check your internet connection, then press Try again.' : 'The exam name in this link did not pass its checks, so no exam was opened.'}
        {...(props.retry ? { action: <Button onClick={props.onRetry}>Try again</Button> } : {})}
        next="Ask the exam board for a new link."
      />
    </Page>
  );
}

export function useVerifiedExamName(examId: Hex | null): string | null {
  const [, bump] = useState(0);
  const name = examId ? verifiedNameOf(examId) : null;
  useEffect(() => {
    if (!examId || name) return;
    let live = true;
    void verifyExamHint(nameLookup, registryAddress, examId).then((found) => {
      if (live && found) bump((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [examId, name]);
  return name;
}

/** What the header shows: the verified name, else the short exam ID. */
export function useExamTitle(examId: Hex | null): string | null {
  const name = useVerifiedExamName(examId);
  return name ?? (examId ? shortExamId(examId) : null);
}

/**
 * The exam in a role page's address. A name there, or in `?exam=`, picks the exam once it passes, and a
 * page on the old form moves to `<path>/<name>` once the current exam's name verifies. The children stay
 * mounted through that move, and an exam with no verified name stays on the old form.
 */
export default function NamedExam(props: { role: string; path: string; children: ReactNode }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(search).get('exam');
  const inPath = examNameInPath(pathname);
  const name = inPath ?? (query && looksLikeEnsName(query) ? query : null);
  const linked = useLinkedName(name);
  const examId = useCurrentExamId();
  const verified = useVerifiedExamName(examId);
  // `?exam=0x..` moves the pointer a moment after this page first shows, so wait for it.
  const pointerSettled = !query?.startsWith('0x') || query === examId;
  const target = inPath ? null : name ? (linked?.check.state === 'open' ? name : null) : pointerSettled ? verified : null;
  const { path } = props;
  useEffect(() => {
    if (target) void navigate(`${path}/${target}`, { replace: true });
  }, [navigate, path, target]);

  if (linked?.check.state === 'refused') return <NameRefused role={props.role} retry={linked.check.retry} onRetry={linked.retry} />;
  if (linked?.check.state === 'checking') return <LoadingSeal />;
  if (name && examId !== verifiedIdOf(name)) return <LoadingSeal />;
  return <>{props.children}</>;
}
