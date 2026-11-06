import { readPartyRecords, type EnsLookup, type ExamRegistry, type PartyRecords } from '@paperseal/chain';
import { KeyError, type Keys } from '@paperseal/keys';
import { fromHex, partyNameProblem, passkeyRecordMatches, passkeyRecordValue, requireHardwareAttestation, toHex, type Hex } from '@paperseal/protocol';
import { TeeApiError, type TeeClient } from '@paperseal/tee-client';
import { Field, KeyTouch, LoadingSeal, Stage, type KeyTouchState, useLoaded } from '@paperseal/ui';
import { useState } from 'react';

import { useCurrentExamId } from './currentExam';
import { loadEnrolments, loadPartyName, savePartyName, type Enrolment } from './enrolment';
import { listEntryForName } from './holder';
import { useMachineElsewhere } from './machineExam';
import { directoryName, nameLookup, useDirectory } from './names';
import {
  browserKeys,
  describeError,
  isSecurityKeyError,
  plainFailure,
  saveCredential,
  Trouble,
  type StoredCredential,
} from './Register';
import { registry as defaultRegistry } from './registry';
import { tee as defaultTee } from './tee';

/*
 * A key holder or centre registers for one exam from the public exam page, with their permanent key
 * and no secret: see "Registration by name" in spec/api.md. The name's records give the credential, so
 * this works in any browser on this domain. Nothing here decides who is on the list: the board's app
 * compares each registration with the name's record. The role is the board's choice, so the credential
 * is kept for both holder pages.
 */

export type PartyTee = Pick<TeeClient, 'registerChallenge' | 'register' | 'registrations'>;

export interface NameRegisterInput {
  keys: Pick<Keys, 'registerByName'>;
  tee: PartyTee;
  lookup: EnsLookup;
  registry: Pick<ExamRegistry, 'getApprovedListEntries'> | null;
  examId: Hex;
  owner: string;
  /** The keys enrolled here. By default, this browser's. */
  enrolments?: readonly Enrolment[];
}

/** A name that can't register, in words. `retry`: reading again may help. */
export class NameProblem extends Error {
  readonly retry: boolean;

  constructor(message: string, retry = false) {
    super(message);
    this.name = 'NameProblem';
    this.retry = retry;
  }
}

function usableRecords(records: PartyRecords): Extract<PartyRecords, { state: 'found' }> {
  switch (records.state) {
    case 'found':
      return records;
    case 'missing':
      throw new NameProblem(`${records.name} has no security key on it yet. Send your key card to whoever runs ${directoryName}.`);
    case 'unreadable':
      throw new NameProblem(`${records.name} can’t be read right now. Try again in a moment.`, true);
    default:
      throw new NameProblem(`${records.name} can’t be used here. ${records.reason}`);
  }
}

/** What to keep once the key is known. Nothing here is secret. */
const credentialFor = (owner: string, credentialId: Hex, passkeyPublicKey: Hex): Omit<StoredCredential, 'role'> => ({ owner, credentialId, passkeyPublicKey });

/**
 * Registers this name for the exam. A key already on the posted list, or already held by the sealed
 * machine under this name, needs no touch: a new browser only has to learn it. Otherwise two touches.
 */
export async function registerName(input: NameRegisterInput): Promise<Omit<StoredCredential, 'role'>> {
  const { keys, tee, lookup, registry, examId, owner } = input;
  const records = usableRecords(await readPartyRecords(owner, { lookup }));
  const belongs = (passkey: Hex) => passkeyRecordMatches(records.passkey, passkeyRecordValue(passkey));

  const listed = registry ? await listEntryForName(registry, examId, owner) : null;
  if (listed && belongs(toHex(listed.passkeyPublicKey))) {
    return credentialFor(owner, records.credentialId, toHex(listed.passkeyPublicKey));
  }
  const held = async () => (await tee.registrations()).registrations.find((item) => item.owner === owner && belongs(item.passkeyPublicKey));
  const already = await held();
  if (already) return credentialFor(owner, records.credentialId, already.passkeyPublicKey);

  const enrolment = (input.enrolments ?? loadEnrolments()).find((item) => item.credentialId === records.credentialId);
  const registration = await keys.registerByName({
    owner,
    examId: fromHex(examId),
    credentialId: fromHex(records.credentialId),
    passkey: records.passkey,
    challenge: async () => fromHex((await tee.registerChallenge()).challenge),
    ...(enrolment ? { attestationObject: fromHex(enrolment.attestationObject) } : {}),
  });
  try {
    await tee.register(registration.request);
  } catch (error) {
    // Another browser got there first. It is the same key, so that is fine if the machine agrees.
    if (!(error instanceof TeeApiError && error.code === 'already_registered' && (await held()))) throw error;
  }
  return credentialFor(owner, records.credentialId, registration.request.passkeyPublicKey);
}

const wrongKey = 'This is not the security key on that name. Check the name, or use the key you set up for it.';

/** The name page's own failure, or null when the caller's general handling should show it. */
function nameFailure(error: unknown): string | null {
  if (error instanceof NameProblem) return error.message;
  if (error instanceof KeyError && error.code === 'wrong_key') return wrongKey;
  if (error instanceof TeeApiError && error.code === 'wrong_stage') return 'Registration for this exam has closed. Contact your exam board.';
  return null;
}

export interface RegisterByNameProps {
  keys?: Pick<Keys, 'registerByName'>;
  tee?: PartyTee | null;
  lookup?: EnsLookup | null;
  registry?: Pick<ExamRegistry, 'getApprovedListEntries'> | null;
  examId?: Hex | null;
  onRegistered?: (credential: StoredCredential) => void;
  next?: string;
}

/** One screen for key holders and centres: a name, then the key. */
export function RegisterByName(props: RegisterByNameProps) {
  const currentExam = useCurrentExamId();
  const examId = props.examId === undefined ? currentExam : props.examId;
  const tee = props.tee === undefined ? defaultTee : props.tee;
  const lookup = props.lookup === undefined ? nameLookup : props.lookup;
  const reader = props.registry === undefined ? defaultRegistry : props.registry;
  const { read } = useDirectory(lookup);
  const machine = useMachineElsewhere(tee, examId ?? null);
  const loaded = useLoaded((!lookup || read !== null) && machine.settled);

  const [typed, setTyped] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  const [touch, setTouch] = useState<KeyTouchState>('idle');
  const [keyError, setKeyError] = useState<unknown>();
  const [failure, setFailure] = useState<{ text: string; detail: string } | null>(null);

  // A name this browser used, or else the listed name holding a key this browser enrolled.
  const mine = read?.records.find((record) => record.state === 'found' && loadEnrolments().some((item) => item.credentialId === record.credentialId));
  const name = typed ?? (loadPartyName() || mine?.name || '');
  const names = read?.directory.state === 'found' ? read.directory.names : [];

  const submit = async () => {
    if (!examId || !tee || !lookup) return;
    const owner = name.trim();
    const problem = partyNameProblem(owner);
    if (problem) {
      setNameError(problem);
      return;
    }
    setFailure(null);
    setNameError(undefined);
    setTouch('waiting');
    try {
      const known = await registerName({ keys: props.keys ?? browserKeys(), tee, lookup, registry: reader, examId, owner });
      savePartyName(owner);
      saveCredential(examId, { ...known, role: 'centre' });
      const credential: StoredCredential = { ...known, role: 'keyholder' };
      saveCredential(examId, credential);
      setTouch('success');
      props.onRegistered?.(credential);
    } catch (cause) {
      const words = nameFailure(cause);
      if (words) {
        setTouch('idle');
        setFailure({ text: words, detail: describeError(cause) });
      } else if (isSecurityKeyError(cause)) {
        setKeyError(cause);
        setTouch('failed');
      } else {
        setTouch('idle');
        setFailure({ text: plainFailure(cause), detail: describeError(cause) });
      }
    }
  };

  if (!examId || !tee || !lookup) {
    return (
      <Stage
        title="Register for this exam"
        lede="This page isn’t connected to an exam yet. Check you opened the link your exam board shared."
        next="Once the link is right, you can register here."
      >
        <details>
          <summary>Details for your exam board</summary>
          <p>{!examId ? 'Publish an exam, or open the exam link, to choose which exam to register for.' : !tee ? 'Set VITE_TEE_URL to connect to the TEE.' : 'Set VITE_RPC_URL to read names.'}</p>
        </details>
      </Stage>
    );
  }

  if (!loaded) return <LoadingSeal />;

  if (machine.elsewhere) {
    return (
      <Stage
        title="Registration is not open yet"
        lede="Your exam board is still setting up this exam."
        next="Come back to this link later, or leave this page open and it moves on by itself."
      />
    );
  }

  return (
    <Stage
      title="Register for this exam"
      lede="Use the name your directory gave you, and the security key you set up for it. You will touch your key twice."
      action={
        <>
          <Field
            label="Your name"
            hint="Like centre-1.paperseal-demo.eth. It is shown on the public list."
            value={name}
            error={nameError}
            list="party-names"
            onChange={(value) => {
              setTyped(value);
              setNameError(undefined);
            }}
          />
          <datalist id="party-names">
            {names.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <KeyTouch
            state={touch}
            error={keyError}
            actionLabel="Register with your security key"
            purpose="to register"
            demo={!requireHardwareAttestation}
            onUse={() => {
              void submit();
            }}
          />
          {failure ? <Trouble detail={[failure.detail]}>{failure.text}</Trouble> : null}
        </>
      }
      next={props.next ?? 'Then your exam board finishes the list of people for this exam. This page moves on by itself.'}
    />
  );
}
