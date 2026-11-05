import { createWebAuthnKeys, KeyError, type Keys, type Registration } from '@paperseal/keys';
import { fromHex, NotImplementedError, toHex, type Hex } from '@paperseal/protocol';
import { TeeApiError, type TeeClient } from '@paperseal/tee-client';
import { Button, EmptyState, Field, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useState } from 'react';

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

export interface RegisterProps {
  role: RegisterRole;
  keys?: Pick<Keys, 'register'>;
  tee?: Pick<TeeClient, 'registerChallenge' | 'register'> | null;
  examId?: Hex | null;
  onRegistered?: (credential: StoredCredential) => void;
}

export function Register(props: RegisterProps) {
  const { role } = props;
  const currentExam = useCurrentExamId();
  const examId = props.examId === undefined ? currentExam : props.examId;
  const tee = props.tee === undefined ? defaultTee : props.tee;
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<StoredCredential | null>(() => (examId ? loadCredential(examId, role) : null));

  const isSetter = role === 'setter';

  const submit = async () => {
    if (!examId || !tee) return;
    setBusy(true);
    setError(null);
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
      setDone(credential);
      props.onRegistered?.(credential);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Register"
      lede={
        isSetter
          ? 'Create a device-bound passkey on your security key. Nothing is ever encrypted to a setter, so no derived key is made, and no name is published.'
          : 'Create a device-bound passkey on your security key.'
      }
    >
      <Panel title="Mocked key">
        In this demo the security key is mocked by Chrome&apos;s virtual authenticator. It is software, and it only
        lasts this browser session. When the session ends the key is gone and cannot be used again, so register again
        in a new session.
      </Panel>
      {done ? (
        <Panel title="Registered">
          <Rows>
            {done.role === 'setter' ? (
              <Row label="Setter">
                <Mono>{done.owner}</Mono>
              </Row>
            ) : (
              <Row label="Name">{done.owner}</Row>
            )}
            <Row label="Role">{done.role}</Row>
            <Row label="Passkey public key">
              <Mono>{done.passkeyPublicKey}</Mono>
            </Row>
          </Rows>
        </Panel>
      ) : (
        <EmptyState title="No key registered">
          {isSetter
            ? 'Registration needs a connection to the TEE. You register with no name.'
            : 'Registration needs a connection to the TEE, and the name the board invited you under.'}
        </EmptyState>
      )}
      {!examId ? (
        <EmptyState title="No exam">Set VITE_EXAM_ID, or publish an exam, to choose which exam to register for.</EmptyState>
      ) : !tee ? (
        <EmptyState title="TEE not connected">Set VITE_TEE_URL to connect to the TEE.</EmptyState>
      ) : (
        <Panel title={done ? 'Register again' : 'Register'}>
          {isSetter ? (
            <p>
              You register with no name. The public approved list shows only a hash of your passkey public key,
              which this page computes after your passkey is created.
            </p>
          ) : (
            <Field label="Name on the approved list" value={owner} onChange={setOwner} />
          )}
          <Button
            disabled={busy || (!isSetter && owner.trim() === '')}
            onClick={() => {
              void submit();
            }}
          >
            {busy ? 'Waiting for your security key' : 'Create passkey and register'}
          </Button>
          {error ? <p role="alert">{error}</p> : null}
        </Panel>
      )}
    </Screen>
  );
}
