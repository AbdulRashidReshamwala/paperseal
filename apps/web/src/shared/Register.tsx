import { createWebAuthnKeys, KeyError, type Keys, type Registration } from '@paperseal/keys';
import { fromHex, NotImplementedError, requireHardwareAttestation, toHex, type Hex, type Invite } from '@paperseal/protocol';
import { TeeApiError, type TeeClient } from '@paperseal/tee-client';
import { Check, KeyTouch, Registered, securityKeyProblem, Stage, type KeyTouchState } from '@paperseal/ui';
import { useState, type ReactNode } from 'react';

import { useCurrentExamId } from './currentExam';
import { credentialsOption } from './demoKeys';
import { credentialIsForInvite, useInvite } from './invite';
import { tee as defaultTee } from './tee';

/*
 * A setter's registration, which starts from an invite link (see `shared/invite.ts`), so nothing is
 * typed, and with no link there is no form. The invite's secret never leaves this device: only the
 * tag the passkey signs goes to the TEE. A setter registers a passkey only (no PRF key) and has no
 * name: its owner is the `setterOwner` hash of its own passkey public key, which `keys.register`
 * computes after the passkey exists. Key holders and centres register by name instead, in
 * `RegisterByName.tsx`. `credentialId` is not secret, but a passkey cannot be used without it, so it
 * is kept in this browser's localStorage per exam and role.
 */

export type RegisterRole = 'setter' | 'keyholder' | 'centre';

export interface StoredCredential {
  owner: string;
  role: RegisterRole;
  credentialId: Hex;
  passkeyPublicKey: Hex;
  /** The tag this key registered with, so a new invite for the same role can be told from the old one. */
  inviteTag?: Hex;
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
    return {
      owner: value.owner,
      role,
      credentialId: value.credentialId,
      passkeyPublicKey: value.passkeyPublicKey,
      ...(hex(value.inviteTag) ? { inviteTag: value.inviteTag } : {}),
    };
  } catch {
    return null;
  }
}

export function saveCredential(examId: Hex, credential: StoredCredential): void {
  storage()?.setItem(storageKey(examId, credential.role), JSON.stringify(credential));
}

/** The browser's real WebAuthn keys. Passkeys only work on this page's domain. */
export function browserKeys(): Keys {
  return createWebAuthnKeys({ rpId: globalThis.location.hostname, rpName: 'Paper Seal', ...credentialsOption() });
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
  /** From the invite link. It holds the secret the tag is made from. */
  invite: Invite;
}

/**
 * Challenge, passkey ceremony, then the TEE's check. Nothing is remembered unless the TEE
 * accepted the registration. The challenge is passed on as the TEE gave it, whatever its width.
 */
export async function registerWithTee(input: RegisterFlowInput): Promise<Registration> {
  const { challenge } = await input.tee.registerChallenge();
  const inviteSecret = fromHex(input.invite.inviteSecret);
  const registration = await input.keys.register({ role: 'setter', challenge: fromHex(challenge), inviteSecret });
  await input.tee.register(registration.request);
  return registration;
}

/** True when the failure came from the security key, so `KeyTouch` can give the right guidance. */
export function isSecurityKeyError(error: unknown): boolean {
  return error instanceof KeyError || securityKeyProblem(error, true) !== 'other';
}

/** A failure that isn't the key's, in plain words for a primary surface. `describeError` has the detail. */
export function plainFailure(error: unknown): string {
  if (error instanceof TypeError) return 'Could not connect to Paper Seal. Check your internet connection, then try again.';
  if (error instanceof TeeApiError) return 'Paper Seal did not accept this. Contact your exam board.';
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

const noLink = {
  title: 'Open your invitation link',
  lede: 'Your exam board sent you a private link. Open that link to register. It says who you are, so there is nothing to type here.',
  next: 'If you can’t find the link, ask your exam board to send it again.',
};

const lede = 'You are registering as a question setter. Your name is not published.';
const nextStep = 'Then your exam board finishes the list of people for this exam. After that you can write your questions here.';

/** The setter's registered screen. `next` says what the page is waiting for, and never that the list is sent unless it is. */
export function SetterRegistered(props: { next?: string }) {
  return (
    <Registered
      message="Your security key is set for this exam."
      next={props.next ?? 'Your exam board is finishing the list of people for this exam. Then this page opens for writing by itself.'}
    />
  );
}

export interface RegisterProps {
  keys?: Pick<Keys, 'register'>;
  tee?: Pick<TeeClient, 'registerChallenge' | 'register'> | null;
  examId?: Hex | null;
  /** The invite to register under. By default the one this browser opened from a link, if any. */
  invite?: Invite | null;
  onRegistered?: (credential: StoredCredential) => void;
  /** Replaces the role's usual "what happens next", when the caller knows better. */
  next?: string;
}

/**
 * A setter's one screen. Everything comes from the invite link, so there is no form: with no usable
 * link it says so in plain words. A Stage only, so the caller's page supplies the header.
 */
export function Register(props: RegisterProps) {
  const role = 'setter';
  const currentExam = useCurrentExamId();
  const examId = props.examId === undefined ? currentExam : props.examId;
  const tee = props.tee === undefined ? defaultTee : props.tee;
  const held = useInvite(role);
  const given = props.invite === undefined ? held : props.invite;
  // A link for another exam or role can't be used on this page.
  const invite = given && given.role === role && (!examId || given.examId === examId) ? given : null;
  const [touch, setTouch] = useState<KeyTouchState>('idle');
  const [keyError, setKeyError] = useState<unknown>();
  const [failure, setFailure] = useState<{ text: string; detail: string } | null>(null);
  const [fresh, setFresh] = useState<StoredCredential | null>(null);

  // The stored key counts only while it belongs to the invite in hand: a new link means a new key.
  const stored = fresh ?? (examId ? loadCredential(examId, role) : null);
  const done = stored && (!invite || credentialIsForInvite(stored, invite)) ? stored : null;

  const submit = async () => {
    if (!examId || !tee || !invite) return;
    setFailure(null);
    setTouch('waiting');
    try {
      const registration = await registerWithTee({ keys: props.keys ?? browserKeys(), tee, invite });
      const credential: StoredCredential = {
        // The owner is the hash `keys.register` computed from the new passkey.
        owner: registration.owner,
        role,
        credentialId: toHex(registration.credentialId),
        passkeyPublicKey: registration.request.passkeyPublicKey,
        inviteTag: registration.request.inviteTag,
      };
      saveCredential(examId, credential);
      setTouch('success');
      setFresh(credential);
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
    return <SetterRegistered />;
  }

  if (!invite) return <Stage title={noLink.title} lede={noLink.lede} next={noLink.next} />;

  return (
    <Stage
      title="Register your security key"
      lede={lede}
      action={
        <>
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
      next={props.next ?? nextStep}
    />
  );
}
