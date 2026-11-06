import { Page, RoleHeader, Stage } from '@paperseal/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** The areas of the app that belong to one role. */
export type GatedRole = 'board' | 'setter' | 'keyholder' | 'centre';

export const rolePages: Record<GatedRole, { label: string; who: string; one: string; path: string; open: string }> = {
  board: { label: 'Exam board', who: 'the exam board', one: 'the exam board', path: '/board', open: 'Open the exam board page' },
  setter: { label: 'Question setter', who: 'question setters', one: 'a question setter', path: '/setter', open: 'Open your setter page' },
  keyholder: { label: 'Key holder', who: 'key holders', one: 'a key holder', path: '/keyholder', open: 'Open your key holder page' },
  centre: { label: 'Exam centre', who: 'exam centres', one: 'an exam centre', path: '/centre', open: 'Open your centre page' },
};

/** What someone sees in place of a role's page: what is wrong, and the one next step. */
export function RoleStop(props: { role: GatedRole; title: string; lede: ReactNode; action?: ReactNode; next: string }) {
  return (
    <Page header={<RoleHeader role={rolePages[props.role].label} />}>
      <Stage title={props.title} lede={props.lede} {...(props.action ? { action: props.action } : {})} next={props.next}>
        <p>
          <Link to="/">Go to the start page</Link>
        </p>
      </Stage>
    </Page>
  );
}
