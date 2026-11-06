import { createWebAuthnKeys, KeyError, type Keys, type Registration } from '@paperseal/keys';
import { fromHex, NotImplementedError, requireHardwareAttestation, toHex, type Hex, type Invite } from '@paperseal/protocol';
import { TeeApiError, type TeeClient } from '@paperseal/tee-client';
import { Check, KeyTouch, securityKeyProblem, Stage, type KeyTouchState } from '@paperseal/ui';
import { useState, type ReactNode } from 'react';

import { useCurrentExamId } from './currentExam';
import { credentialIsForInvite, useInvite } from './invite';
import { tee as defaultTee } from './tee';

/*
 * Registration is the same for setters, key holders and centres, and it starts from an invite link
 * (see `shared/invite.ts`): the role and the name come from the link, so nothing is typed, and with
 * no link there is no form. The invite's secret never leaves this device: only the tag the passkey
 * signs goes to the TEE. A setter registers a passkey only (no PRF key) and has no name: its owner
 * is the `setterOwner` hash of its own passkey public key, which `keys.register` computes after the
 * passkey exists. The README's Hardware Keys section describes the ceremony. `credentialId` is not secret, but a passkey cannot be used without it,
 * so it is kept in this browser's localStorage per exam and role. A key holder and a centre are
 * separate roles with separate keys, because one browser can hold both.
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
  /** From the invite link. It names the role and the owner, and holds the secret the tag is made from. */
  invite: Invite;
}

/**
 * Challenge, passkey ceremony, then the TEE's check. Nothing is remembered unless the TEE
 * accepted the registration. The challenge is passed on as the TEE gave it, whatever its width.
 */
export async function registerWithTee(input: RegisterFlowInput): Promise<Registration> {
  const { challenge } = await input.tee.registerChallenge();
  const { invite } = input;
  const inviteSecret = fromHex(invite.inviteSecret);
  const registration = await input.keys.register(
    invite.role === 'setter' || invite.owner === undefined
      ? { role: 'setter', challenge: fromHex(challenge), inviteSecret }
      : { role: 'holder', owner: invite.owner, challenge: fromHex(challenge), inviteSecret },
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

const roleCopy: Record<RegisterRole, { lede: (owner: string | undefined) => string; next: string }> = {
  setter: {
    lede: () =>
      'You are registering as a question setter. Your name is not published.',
    next: 'Then your exam board finishes the list of people for this exam. After that you can write your questions here.',
  },
  keyholder: {
    lede: (owner) => `You are registering as ${owner ?? 'a key holder'}. A key holder keeps part of the key that opens the paper. Your name will be on the public list for this exam.`,
    next: 'Then you have nothing to do until the paper unlocks. This page shows when. Keep your security key safe.',
  },
  centre: {
    lede: (owner) => `You are registering ${owner ?? 'your centre'} as an exam centre. The name will be on the public list for this exam.`,
    next: 'Then your exam board finishes the list of people for this exam. After that, this page gets the sealed paper ready.',
  },
};

const newKey = 'To use a different security key, ask your exam board for a new invitation link.';

export interface RegisterProps {
  role: RegisterRole;
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
 * One screen for every role, and one key touch. The role and name come from the invite link, so there
 * is no form: with no usable link it says so in plain words. A Stage only, so the caller's page
 * supplies the header.
 */
export function Register(props: RegisterProps) {
  const { role } = props;
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

  const copy = roleCopy[role];
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
        // A setter's owner is the hash `keys.register` computed from its new passkey.
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
    return (
      <Stage
        title="Your security key is registered"
        {...(role !== 'setter' ? { lede: `Registered as ${done.owner}.` } : {})}
        next={`${copy.next} ${newKey}`}
      />
    );
  }

  if (!invite) return <Stage title={noLink.title} lede={noLink.lede} next={noLink.next} />;

  return (
    <Stage
      title="Register your security key"
      lede={copy.lede(invite.owner)}
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
      next={props.next ?? copy.next}
    />
  );
}
