import { roles, threshold } from '@paperseal/protocol';
import { Button, Field } from '@paperseal/ui';
import { useMemo, useState } from 'react';

import { useBoardForm } from './BoardForm';
import { DraftPage, type DraftRail } from './DraftFrame';
import { useDirectoryNames, type ChosenParty } from './parties';
import { AddName } from './PeopleStep';
import { centresProblem, neutralsProblem } from './plan';
import { roleNames } from './registrations';

/** Past this many names, the page offers a search. */
const SEARCH_FROM = 8;

const WORDS = {
  centres: {
    title: 'Choose the centres',
    lede: `Centres receive the sealed paper and open it on exam day. ${String(threshold.centres)} of them hold part of the key.`,
    count: 'centres holding part of the key',
    need: threshold.centres,
  },
  neutrals: {
    title: 'Choose the neutral parties',
    lede: `Neutral parties hold part of the key, so the centres cannot open the paper by themselves. You need ${String(threshold.neutrals)}.`,
    count: 'neutral parties',
    need: threshold.neutrals,
  },
};

const isCentre = (party: ChosenParty) => party.role === roles.centreKeyHolder || party.role === roles.centre;
const isNeutral = (party: ChosenParty) => party.role === roles.neutral;

/**
 * Picks centres or neutral parties from the directory while the exam is still a draft. The page is
 * complete once it has the counts the approved list needs. The names carry over to the exam's "Choose
 * who takes part" page, where everyone registers and each name is checked by its own records.
 */
export function PartyStep(props: { kind: 'centres' | 'neutrals'; rail: DraftRail; onBack: () => void; onContinue: () => void }) {
  const { kind } = props;
  const { plan, setPlan, environment } = useBoardForm();
  const directory = useDirectoryNames(environment.ensLookup);
  const [search, setSearch] = useState('');
  const words = WORDS[kind];
  const mine = (party: ChosenParty) => (kind === 'centres' ? isCentre(party) : isNeutral(party));
  const chosen = plan.parties.filter(mine);
  const others = plan.parties.filter((party) => !mine(party));
  const counted = kind === 'centres' ? chosen.filter((party) => party.role === roles.centreKeyHolder).length : chosen.length;
  const full = kind === 'neutrals' && counted >= words.need;
  const problem = kind === 'centres' ? centresProblem(plan.parties) : neutralsProblem(plan.parties);

  const listed = useMemo(() => (directory.read?.state === 'found' ? directory.read.names : []), [directory.read]);
  const all = [...new Set([...listed, ...chosen.map((party) => party.name)])].filter((name) => !others.some((party) => party.name === name));
  const shown = search.trim() === '' ? all : all.filter((name) => name.includes(search.trim().toLowerCase()));

  const roleFor = (): number => {
    if (kind === 'neutrals') return roles.neutral;
    return counted < threshold.centres ? roles.centreKeyHolder : roles.centre;
  };
  const tick = (name: string, ticked: boolean) => {
    setPlan({
      ...plan,
      parties: ticked ? [...plan.parties, { name, role: roleFor() }] : plan.parties.filter((party) => party.name !== name),
    });
  };
  const setRole = (name: string, role: number) => {
    setPlan({ ...plan, parties: plan.parties.map((party) => (party.name === name ? { ...party, role } : party)) });
  };

  const unread = environment.ensLookup && directory.read && directory.read.state !== 'found';
  return (
    <DraftPage
      rail={props.rail}
      title={words.title}
      lede={words.lede}
      ready={problem === null}
      blocked={problem}
      onBack={props.onBack}
      onContinue={props.onContinue}
    >
      <p className="board-party-count" role="status">
        <strong>
          {counted} of {words.need}
        </strong>{' '}
        {words.count}
      </p>
      {all.length > SEARCH_FROM ? <Field label="Search the names" value={search} onChange={setSearch} /> : null}
      {unread ? (
        <div className="board-party-unread">
          <p>The list of names cannot be read right now. You can add a name below.</p>
          <Button onClick={directory.retry}>Try again</Button>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul className="board-party-list">
          {shown.map((name) => {
            const party = chosen.find((item) => item.name === name);
            return (
              <li key={name}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Include ${name}`}
                    checked={party !== undefined}
                    disabled={!party && full}
                    onChange={(event) => {
                      tick(name, event.target.checked);
                    }}
                  />
                  {name}
                </label>
                {party && kind === 'centres' ? (
                  <select
                    className="ps-input board-role"
                    aria-label={`Role for ${name}`}
                    value={party.role ?? roles.centre}
                    onChange={(event) => {
                      setRole(name, Number(event.target.value));
                    }}
                  >
                    {[roles.centreKeyHolder, roles.centre].map((role) => (
                      <option key={role} value={role}>
                        {roleNames[role]}
                      </option>
                    ))}
                  </select>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <AddName
        taken={[...all, ...others.map((party) => party.name)]}
        onAdd={(name) => {
          tick(name, true);
        }}
      />
      <p className="board-note">You can change these after publishing. Each one registers with their security key then.</p>
    </DraftPage>
  );
}
