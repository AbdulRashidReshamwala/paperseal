import { createWebAuthnKeys, KeyError, type Keys, type Registration } from '@paperseal/keys';
import { fromHex, NotImplementedError, requireHardwareAttestation, toHex, type Hex } from '@paperseal/protocol';
import { TeeApiError, type TeeClient } from '@paperseal/tee-client';
import { Button, Check, Field, KeyTouch, securityKeyProblem, Stage, type KeyTouchState } from '@paperseal/ui';
import { useRef, useState, type ReactNode } from 'react';

import { useCurrentExamId } from './currentExam';
import { tee as defaultTee } from './tee';

/*
 * Registration is the same for setters, key holders and centres. A setter registers a passkey
 * only (no PRF key) and has no name: its owner is the `setterOwner` hash of its own passkey public
 * key, which `keys.register` computes after the passkey exists. The README's Hardware Keys section
 * describes the ceremony. `credentialId` is not secret, but a passkey cannot be used without it,
 * so it is kept in this browser's localStorage per exam and role. A key holder and a centre are
 * separate roles with separate keys, because one browser can hold both.
 */

export type RegisterRole = 'setter' | 'keyholder' | 'centre';

export interface StoredCredential {
  owner: string;
  role: RegisterRole;
  credentialId: Hex;
  passkeyPublicKey: Hex;
}

const storageKey = (examId: Hex, role: RegisterRole) => `paperseal.credential.${examId.toLowerCase()}.${role}`;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function loadCredential(examId: Hex, role: RegisterRole): StoredCredential | null {
  try {
    const raw = storage()?.getItem(storageKey(examId, role));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredCredential>;
    const hex = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]+$/.test(v);
    if (typeof value.owner !== 'string' || !hex(value.credentialId) || !hex(value.passkeyPublicKey)) return null;
    return { owner: value.owner, role, credentialId: value.credentialId, passkeyPublicKey: value.passkeyPublicKey };
  } catch {
    return null;
  }
}

export function saveCredential(examId: Hex, credential: StoredCredential): void {
  storage()?.setItem(storageKey(examId, credential.role), JSON.stringify(credential));
}

/** The browser's real WebAuthn keys. Passkeys only work on this page's domain. */
export function browserKeys(): Keys {
  return createWebAuthnKeys({ rpId: globalThis.location.hostname, rpName: 'Paper Seal' });
}

/** Plain words for a failure, never a stack trace. */
export function describeError(error: unknown): string {
  if (error instanceof TeeApiError) return `The TEE refused the request: ${error.message} (${error.code}).`;
  if (error instanceof KeyError) return error.message;
  if (error instanceof NotImplementedError) return error.message;
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'The security key request was cancelled or timed out.';
  }
  if (error instanceof TypeError) {
    return 'Could not reach the TEE. Check your network connection and the TEE address.';
  }
  return error instanceof Error ? error.message : String(error);
}

export interface RegisterFlowInput {
  keys: Pick<Keys, 'register'>;
  tee: Pick<TeeClient, 'registerChallenge' | 'register'>;
  /** The name a key holder or centre registers under. A setter has none, so it is ignored for one. */
  owner: string;
  role: RegisterRole;
}

/**
 * Challenge, passkey ceremony, then the TEE's check. Nothing is remembered unless the TEE
 * accepted the registration. The challenge is passed on as the TEE gave it, whatever its width.
 */
export async function registerWithTee(input: RegisterFlowInput): Promise<Registration> {
  const { challenge } = await input.tee.registerChallenge();
  const registration = await input.keys.register(
    input.role === 'setter'
      ? { role: 'setter', challenge: fromHex(challenge) }
      : { role: 'holder', owner: input.owner, challenge: fromHex(challenge) },
  );
  await input.tee.register(registration.request);
  return registration;
}

/** True when the failure came from the security key, so `KeyTouch` can give the right guidance. */
export function isSecurityKeyError(error: unknown): boolean {
  return error instanceof KeyError || securityKeyProblem(error, true) !== 'other';
}

/** A failure that isn't the key's, in plain words for a primary surface. `describeError` has the detail. */
export function plainFailure(error: unknown): string {
  if (error instanceof TypeError) return 'Could not reach the sealed system. Check your internet connection, then try again.';
  if (error instanceof TeeApiError) return 'The sealed system refused this. Contact your exam board.';
  return 'Something went wrong. Try again, and contact your exam board if it keeps happening.';
}

/** A failure in words, with the technical reason folded away for the exam board. */
export function Trouble(props: { children: ReactNode; detail?: readonly string[] }) {
  return (
    <div role="alert">
      <Check status="fail">{props.children}</Check>
      {props.detail && props.detail.length > 0 ? (
        <details>
          <summary>Details for your exam board</summary>
          <ul>
            {props.detail.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

const roleCopy: Record<RegisterRole, { lede: string; next: string }> = {
  setter: {
    lede: 'Your name is never published. The public list shows only a code made from your security key, so this page doesn’t ask who you are.',
    next: 'Your exam board publishes the approved list. Then you can write your questions.',
  },
  keyholder: {
    lede: 'Enter the name your exam board invited you under. It appears on the public approved list.',
    next: 'Your exam board publishes the approved list. You have nothing else to do until release day.',
  },
  centre: {
    lede: 'Enter your centre’s name as your exam board invited it. It appears on the public approved list.',
    next: 'Your exam board publishes the approved list. You can then download the sealed paper.',
  },
};

export interface RegisterProps {
  role: RegisterRole;
  keys?: Pick<Keys, 'register'>;
  tee?: Pick<TeeClient, 'registerChallenge' | 'register'> | null;
  examId?: Hex | null;
  onRegistered?: (credential: StoredCredential) => void;
  /** Goes straight to the key touch, for someone replacing a key already stored here. */
  again?: boolean;
  /** Replaces the role's usual "what happens next", when the caller knows better. */
  next?: string;
}

/**
 * One screen for every role: one name field where the role needs a name, and one key touch. A
 * Stage only, so the caller's page supplies the header.
 */
export function Register(props: RegisterProps) {
  const { role } = props;
  const currentExam = useCurrentExamId();
  const examId = props.examId === undefined ? currentExam : props.examId;
  const tee = props.tee === undefined ? defaultTee : props.tee;
  const [owner, setOwner] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [touch, setTouch] = useState<KeyTouchState>('idle');
  const [keyError, setKeyError] = useState<unknown>();
  const [failure, setFailure] = useState<{ text: string; detail: string } | null>(null);
  const [done, setDone] = useState<StoredCredential | null>(() =>
    examId && !props.again ? loadCredential(examId, role) : null,
  );
  const nameField = useRef<HTMLDivElement>(null);

  const needsName = role !== 'setter';
  const copy = roleCopy[role];

  const submit = async () => {
    if (!examId || !tee) return;
    if (needsName && owner.trim() === '') {
      setNameError('Enter your name first.');
      nameField.current?.querySelector('input')?.focus();
      return;
    }
    setNameError(undefined);
    setFailure(null);
    setTouch('waiting');
    try {
      const registration = await registerWithTee({ keys: props.keys ?? browserKeys(), tee, owner: owner.trim(), role });
      const credential: StoredCredential = {
        // A setter's owner is the hash `keys.register` computed from its new passkey.
        owner: registration.owner,
        role,
        credentialId: toHex(registration.credentialId),
        passkeyPublicKey: registration.request.passkeyPublicKey,
      };
      saveCredential(examId, credential);
      setTouch('success');
      setDone(credential);
      props.onRegistered?.(credential);
    } catch (cause) {
      if (isSecurityKeyError(cause)) {
        setKeyError(cause);
        setTouch('failed');
      } else {
        setTouch('idle');
        setFailure({ text: plainFailure(cause), detail: describeError(cause) });
      }
    }
  };

  if (!examId || !tee) {
    return (
      <Stage
        title="Register your security key"
        lede="This page isn’t connected to an exam yet. Check you opened the link your exam board sent."
        next="Once the link is right, you can register here."
      >
        <details>
          <summary>Details for your exam board</summary>
          <p>
            {!examId ? 'Set VITE_EXAM_ID, or publish an exam, to choose which exam to register for.' : 'Set VITE_TEE_URL to connect to the TEE.'}
          </p>
        </details>
      </Stage>
    );
  }

  if (done) {
    return (
      <Stage
        title="Your security key is registered"
        {...(needsName ? { lede: `Registered as ${done.owner}.` } : {})}
        next={copy.next}
      >
        <Button
          onClick={() => {
            setDone(null);
            setTouch('idle');
          }}
        >
          Register a different key
        </Button>
      </Stage>
    );
  }

  return (
    <Stage
      title="Register your security key"
      lede={copy.lede}
      action={
        <>
          {needsName ? (
            <div ref={nameField}>
              <Field
                label="Name on the approved list"
                value={owner}
                error={nameError}
                onChange={(value) => {
                  setOwner(value);
                  setNameError(undefined);
                }}
              />
            </div>
          ) : null}
          <KeyTouch
            state={touch}
            error={keyError}
            actionLabel="Register your security key"
            purpose="to register"
            demo={!requireHardwareAttestation}
            onUse={() => {
              void submit();
            }}
          />
          {failure ? <Trouble detail={[failure.detail]}>{failure.text}</Trouble> : null}
        </>
      }
      next={props.next ?? copy.next}
    />
  );
}
