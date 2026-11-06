import { Button, Field } from '@paperseal/ui';
import { useState, type FormEvent } from 'react';

import { createInvites, createSetters, parseNames, type BoardInvite } from './invites';

/**
 * Makes invites in bulk: one box per role with a name on each line, and a number for setters, who
 * need no name. Nothing is added unless every line passes, so the box can be fixed and added again.
 */
export function AddInvites(props: {
  invites: readonly BoardInvite[];
  /** How many setters the exam needs at least, when known. */
  settersNeeded?: number | undefined;
  onAdd: (invites: readonly BoardInvite[]) => void;
}) {
  const [holders, setHolders] = useState('');
  const [centres, setCentres] = useState('');
  const [count, setCount] = useState('');
  const [errors, setErrors] = useState<{ holders?: string | undefined; centres?: string | undefined; setters?: string | undefined }>({});

  const names = parseNames(holders).length + parseNames(centres).length;
  const setters = /^\d+$/.test(count.trim()) ? Number(count.trim()) : null;

  const addPeople = (event: FormEvent) => {
    event.preventDefault();
    const kh = createInvites(props.invites, 'keyholder', holders);
    // The centres are checked against the key holders in the same go, so one name can't be used twice.
    const made = kh.ok ? kh.invites : [];
    const ce = createInvites([...props.invites, ...made], 'centre', centres);
    if (kh.ok && ce.ok) {
      setErrors({});
      setHolders('');
      setCentres('');
      props.onAdd([...kh.invites, ...ce.invites]);
      return;
    }
    setErrors({
      ...(kh.ok ? {} : { holders: kh.reasons.join(' ') }),
      ...(ce.ok ? {} : { centres: ce.reasons.join(' ') }),
    });
  };

  const addSetters = (event: FormEvent) => {
    event.preventDefault();
    const made = createSetters(props.invites, setters ?? Number.NaN);
    if (!made.ok) {
      setErrors({ setters: made.reason });
      return;
    }
    setErrors({});
    setCount('');
    props.onAdd(made.invites);
  };

  return (
    <>
      <form className="board-invite-form" onSubmit={addPeople}>
        <label className="ps-field">
          <span>Key holders</span>
          <span className="ps-field-hint">One name on each line. The names are shown on the public list.</span>
          <textarea
            className="ps-input"
            rows={4}
            value={holders}
            aria-invalid={errors.holders ? true : undefined}
            onChange={(event) => {
              setHolders(event.target.value);
              setErrors({ ...errors, holders: undefined });
            }}
          />
          {errors.holders ? <span className="ps-field-error" role="alert">{errors.holders}</span> : null}
        </label>
        <label className="ps-field">
          <span>Centres</span>
          <span className="ps-field-hint">One name on each line. The names are shown on the public list.</span>
          <textarea
            className="ps-input"
            rows={4}
            value={centres}
            aria-invalid={errors.centres ? true : undefined}
            onChange={(event) => {
              setCentres(event.target.value);
              setErrors({ ...errors, centres: undefined });
            }}
          />
          {errors.centres ? <span className="ps-field-error" role="alert">{errors.centres}</span> : null}
        </label>
        <Button type="submit" disabled={names === 0}>
          {names === 0 ? 'Add the people' : `Add ${String(names)} ${names === 1 ? 'person' : 'people'}`}
        </Button>
      </form>
      <form className="board-invite-form" onSubmit={addSetters}>
        <Field
          label="Setters"
          hint={`Setters need no name. Enter how many you want to invite${props.settersNeeded ? `. At least ${String(props.settersNeeded)} are needed` : ''}.`}
          value={count}
          error={errors.setters}
          onChange={(value) => {
            setCount(value);
            setErrors({ ...errors, setters: undefined });
          }}
        />
        <Button type="submit" disabled={setters === null || setters < 1}>
          {setters && setters >= 1 ? `Add ${String(setters)} ${setters === 1 ? 'setter' : 'setters'}` : 'Add setters'}
        </Button>
      </form>
    </>
  );
}
