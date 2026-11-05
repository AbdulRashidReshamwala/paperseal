import {
  fromHex,
  inviteTag,
  toHex,
  type Hex,
  type Invite,
  type InviteRole,
} from '@paperseal/protocol';
import { useSyncExternalStore } from 'react';

/*
 * The invite a registrant opened. It comes from the URL fragment of the board's link, is read once
 * by `Join`, and is then held here, in memory only: the address bar is cleared, and nothing is
 * written to storage or sent anywhere. Reloading the page forgets it, and the link opens it again.
 * One invite is held per role, so one browser can still be a key holder and a centre.
 */

const held = new Map<InviteRole, Invite>();
const listeners = new Set<() => void>();

const notify = () => {
  listeners.forEach((listener) => {
    listener();
  });
};

/** The page for each role. The invite link opens `/join`, which moves on to this. */
export const rolePaths: Record<InviteRole, string> = {
  setter: '/setter',
  keyholder: '/keyholder',
  centre: '/centre',
};

export function holdInvite(invite: Invite): void {
  held.set(invite.role, invite);
  notify();
}

export function heldInvite(role: InviteRole): Invite | null {
  return held.get(role) ?? null;
}

/** For tests: forgets every held invite. */
export function clearHeldInvites(): void {
  held.clear();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInvite(role: InviteRole): Invite | null {
  return useSyncExternalStore(
    subscribe,
    () => heldInvite(role),
    () => null,
  );
}

/** The tag a passkey registered under this invite carries. */
export function tagFor(invite: Pick<Invite, 'inviteSecret'>, passkeyPublicKey: Hex): Hex {
  return toHex(inviteTag(fromHex(invite.inviteSecret), fromHex(passkeyPublicKey)));
}

/** Whether a stored credential was registered under this invite. A credential from an older one isn't. */
export function credentialIsForInvite(
  credential: { passkeyPublicKey: Hex; inviteTag?: Hex | undefined },
  invite: Pick<Invite, 'inviteSecret'>,
): boolean {
  return credential.inviteTag !== undefined && credential.inviteTag === tagFor(invite, credential.passkeyPublicKey);
}
