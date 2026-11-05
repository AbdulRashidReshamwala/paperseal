import type { ReactNode } from 'react';

import { CheckIcon, ClockIcon, CrossIcon, DashIcon } from './icons';

export type CheckStatus = 'pass' | 'fail' | 'pending' | 'not-checked';

const WORDS: Record<CheckStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  pending: 'Pending',
  'not-checked': 'Not checked',
};

const ICONS: Record<CheckStatus, () => ReactNode> = {
  pass: CheckIcon,
  fail: CrossIcon,
  pending: ClockIcon,
  'not-checked': DashIcon,
};

/** The result of one check: always an icon and a word, never colour alone. */
export function Check(props: {
  status: CheckStatus;
  /** Optional reason, printed after the word. */
  children?: ReactNode;
}) {
  const Icon = ICONS[props.status];
  return (
    <span className="ps-check" data-status={props.status}>
      <Icon />
      <span className="ps-check-word">{WORDS[props.status]}</span>
      {props.children ? <span className="ps-check-detail">{props.children}</span> : null}
    </span>
  );
}
