import { PrimaryAction } from '@paperseal/ui';
import type { ReactNode } from 'react';

import { rolePages, RoleStop, type GatedRole } from '../shared/RolePage';
import { activePersona, becomePersona, personas, type Persona } from './personas';

/** In demo mode the person in the bar has one role. Anyone else gets a way to become someone who has it. */
export default function PersonaGate(props: { role: GatedRole; children: ReactNode }) {
  const { role } = props;
  const page = rolePages[role];
  const persona = activePersona();
  if (persona.path === page.path) return props.children;
  const next = personas.find(({ path }) => path === page.path) as Persona;
  return (
    <RoleStop
      role={role}
      title={`This page is for ${page.who}`}
      lede={`You are acting as ${persona.label}.`}
      action={
        <PrimaryAction
          onClick={() => {
            becomePersona(next);
          }}
        >
          {`Switch to ${next.label}`}
        </PrimaryAction>
      }
      next="This takes you to that person’s page."
    />
  );
}
