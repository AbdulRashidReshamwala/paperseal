import { KeyError, type Keys } from '@paperseal/keys';
import { fromHex, keyCardText, requireHardwareAttestation, toHex, type KeyCard } from '@paperseal/protocol';
import { Button, KeyTouch, LoadingSeal, Page, RoleHeader, Row, Rows, Stage, type KeyTouchState, useLoaded } from '@paperseal/ui';
import { useState } from 'react';

import '../release/holder.css';
import { keyCardOf, loadEnrolments, saveEnrolment, type Enrolment } from './enrolment';
import { directoryName, nameLookup, useDirectory, type DirectoryRead } from './names';
import { browserKeys, describeError, isSecurityKeyError, plainFailure, Trouble } from './Register';

/*
 * Enrolment, from "Party Names" in spec/api.md. One touch makes a permanent passkey, and the key card
 * carries its public values to the directory owner. Every key this page knows of is passed as
 * `excludeCredentials`, so doing this twice with one key is refused and never makes a second identity.
 * The user handle is random, because a create with a repeated one would overwrite the earlier passkey.
 */

/** The credentials the directory publishes, for `excludeCredentials`. */
function publishedCredentials(read: DirectoryRead | null): Uint8Array[] {
  return (read?.records ?? []).flatMap((record) => (record.state === 'found' ? [fromHex(record.credentialId)] : []));
}

/** Makes the passkey and remembers it. Throws `KeyError('already_enrolled')` for a key already known. */
export async function enrol(keys: Pick<Keys, 'generateKey'>, known: readonly Uint8Array[]): Promise<Enrolment> {
  const made = await keys.generateKey(
    { id: globalThis.crypto.getRandomValues(new Uint8Array(32)), name: 'Paper Seal key' },
    { excludeCredentials: [...loadEnrolments().map((item) => fromHex(item.credentialId)), ...known] },
  );
  const enrolment: Enrolment = {
    credentialId: toHex(made.credentialId),
    passkeyPublicKey: toHex(made.passkeyPublicKey),
    attestationObject: toHex(made.attestationObject),
  };
  saveEnrolment(enrolment);
  return enrolment;
}

function CopyCard(props: { text: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const onClick = () => {
    // navigator.clipboard is missing outside a secure context.
    const written = (globalThis.navigator as Navigator | undefined)?.clipboard?.writeText(props.text);
    if (!written) {
      setCopy('failed');
      return;
    }
    written.then(
      () => {
        setCopy('copied');
      },
      () => {
        setCopy('failed');
      },
    );
  };
  return (
    <>
      <Button aria-label="Copy your key card" onClick={onClick}>
        {copy === 'copied' ? 'Copied' : 'Copy your key card'}
      </Button>
      {copy === 'failed' ? <p role="status">The card could not be copied. Open the full card below and copy it yourself.</p> : null}
    </>
  );
}

function CardView(props: { card: KeyCard }) {
  const text = keyCardText(props.card);
  return (
    <div className="enrol-card">
      <Rows>
        <Row label="Security key">
          <span className="ps-mono">{props.card.passkey}</span>
        </Row>
        <Row label="Key number">
          <span className="ps-mono">{props.card.credentialId}</span>
        </Row>
      </Rows>
      <CopyCard text={text} />
      <details>
        <summary>The full card</summary>
        <pre className="ps-mono" aria-label="Your key card">
          {text}
        </pre>
      </details>
    </div>
  );
}

const SEND = `Send this card to whoever runs ${directoryName}. They put it on your name, and you use that name for every exam.`;
const NOT_SECRET = 'Nothing on this card is secret, so any message is fine for sending it.';

export function EnrolView(props: { keys?: Pick<Keys, 'generateKey'>; known?: readonly Uint8Array[]; directoryUnread?: boolean }) {
  const [enrolled, setEnrolled] = useState<Enrolment | null>(() => loadEnrolments().at(-1) ?? null);
  const [another, setAnother] = useState(false);
  const [refused, setRefused] = useState(false);
  const [touch, setTouch] = useState<KeyTouchState>('idle');
  const [keyError, setKeyError] = useState<unknown>();
  const [failure, setFailure] = useState<{ text: string; detail: string } | null>(null);

  const use = async () => {
    setFailure(null);
    setTouch('waiting');
    try {
      const made = await enrol(props.keys ?? browserKeys(), props.known ?? []);
      setEnrolled(made);
      setAnother(false);
      setTouch('idle');
    } catch (cause) {
      if (cause instanceof KeyError && cause.code === 'already_enrolled') {
        setTouch('idle');
        setRefused(true);
      } else if (isSecurityKeyError(cause)) {
        setKeyError(cause);
        setTouch('failed');
      } else {
        setTouch('idle');
        setFailure({ text: plainFailure(cause), detail: describeError(cause) });
      }
    }
  };

  if (refused) {
    return (
      <Stage
        title="This security key is already set up"
        lede="Nothing new was made, and your key still works as it did."
        action={
          <Button
            onClick={() => {
              setRefused(false);
            }}
          >
            Use a different key
          </Button>
        }
        next={`If you have lost your key card, ask whoever runs ${directoryName}. Your name already shows your key.`}
      />
    );
  }

  if (enrolled && !another) {
    return (
      <Stage
        title="Your key card"
        lede={NOT_SECRET}
        action={<CardView card={keyCardOf(enrolled)} />}
        next={SEND}
      >
        <p>
          <Button
            onClick={() => {
              setAnother(true);
            }}
          >
            Set up a different key
          </Button>
        </p>
      </Stage>
    );
  }

  return (
    <Stage
      title="Set up your security key"
      lede="You do this once. It gives you a key card, which you send to the person who runs your directory."
      action={
        <>
          <KeyTouch
            state={touch}
            error={keyError}
            actionLabel="Set up your security key"
            purpose="to set it up"
            demo={!requireHardwareAttestation}
            onUse={() => {
              void use();
            }}
          />
          {failure ? <Trouble detail={[failure.detail]}>{failure.text}</Trouble> : null}
        </>
      }
      next="Then you use this same key for every exam."
    >
      {props.directoryUnread ? (
        <p role="status">The directory can’t be read right now, so this page can’t tell if your key is already on it. You can go on, or try again later.</p>
      ) : null}
    </Stage>
  );
}

export default function Enrol() {
  const { read } = useDirectory();
  const known = publishedCredentials(read);
  const unread = read !== null && ['refused', 'unreadable', 'invalid'].includes(read.directory.state);
  const loaded = useLoaded(!nameLookup || read !== null);
  return (
    <Page header={<RoleHeader role="Your security key" />}>
      {loaded ? <EnrolView known={known} directoryUnread={unread} /> : <LoadingSeal />}
    </Page>
  );
}
