/// <reference types="vite/client" />
import '../src/tokens.css';
import './preview.css';

import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  Badge,
  Button,
  Check,
  Countdown,
  Connected,
  EmptyState,
  Field,
  Hash,
  KeyTouch,
  Logo,
  Mono,
  Panel,
  PrimaryAction,
  RoleHeader,
  Row,
  Rows,
  Screen,
  Seal,
  Stage,
  Stamp,
  Stepper,
  Wordmark,
  type ActionStatus,
  type KeyTouchState,
  type SealState,
  type Step,
} from '../src/index';

// Every value on this page is a made-up specimen for showing the design.
const HASH = '0x38223aaacebb6b38a4ae87d63a4d77692d761dcf1659b33bc2ae91676b6923c7';
const OTHER_HASH = '0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295';
const SAMPLE_EXAM = 'Physics Paper 2 · Sample';
const LOADED_AT = Date.now();
const noKey = new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');

const custody: Step[] = [
  {
    id: 'build',
    label: 'Paper assembled inside the sealed machine',
    state: 'done',
    when: '4 Nov, 09:12',
    note: 'No person saw the finished paper.',
    evidence: (
      <Rows>
        <Row label="Code version">
          <Hash value={HASH} label="code version" />
        </Row>
        <Row label="Machine proof">
          <Check status="pass">Checked just now</Check>
        </Row>
      </Rows>
    ),
  },
  {
    id: 'published',
    label: 'Sealed paper published to every centre',
    state: 'done',
    when: '4 Nov, 09:31',
    evidence: (
      <Rows>
        <Row label="Sealed paper">
          <Hash value={OTHER_HASH} label="sealed paper" />
        </Row>
      </Rows>
    ),
  },
  { id: 'centres', label: 'Centres confirmed the same paper', state: 'not-applicable', when: 'Not recorded', note: 'This exam has no centre receipts.' },
  { id: 'time', label: 'Paper becomes ready to open', state: 'current', when: '6 Nov, 09:59', note: '6 of 8 key holders have released so far.' },
  { id: 'unlock', label: 'Paper unlocks at centres', state: 'waiting', when: '6 Nov, 09:59' },
  { id: 'proof', label: 'Full proof published after the exam', state: 'failed', when: '6 Nov, 12:59', note: 'The paper did not match its published fingerprint.' },
];

function useTheme() {
  const [theme, setTheme] = useState<'paper' | 'dark'>('paper');
  useEffect(() => {
    if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
    else document.documentElement.removeAttribute('data-theme');
  }, [theme]);
  return [theme, setTheme] as const;
}

function Section(props: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="pv-section">
      <h2>{props.title}</h2>
      {props.intro ? <p>{props.intro}</p> : null}
      {props.children}
    </section>
  );
}

function Specimen(props: { title: string; children: ReactNode }) {
  return (
    <div className="pv-specimen">
      <h3>{props.title}</h3>
      {props.children}
    </div>
  );
}

const SWATCHES = [
  ['Paper', '--ps-paper'],
  ['Deep paper', '--ps-paper-deep'],
  ['Ink', '--ps-ink'],
  ['Soft ink', '--ps-ink-soft'],
  ['Rule', '--ps-rule'],
  ['Wax', '--ps-wax'],
  ['Seal ink', '--ps-seal-ink'],
  ['Pass', '--ps-pass'],
  ['Pending', '--ps-pending'],
  ['Fail', '--ps-fail'],
];

function LiveSeal() {
  const [state, setState] = useState<SealState>('sealed');
  return (
    <>
      <Seal state={state} size={148} caption />
      <div className="pv-controls">
        {(['sealed', 'opening', 'open', 'broken'] as const).map((next) => (
          <Button
            key={next}
            aria-pressed={state === next}
            onClick={() => {
              setState(next);
            }}
          >
            {next}
          </Button>
        ))}
      </div>
    </>
  );
}

function LiveAction() {
  const [status, setStatus] = useState<ActionStatus>('idle');
  return (
      <PrimaryAction
        status={status}
        busyLabel="Sealing the paper"
        doneLabel="Sealed"
        onClick={() => {
          setStatus('busy');
          setTimeout(() => {
            setStatus('done');
          }, 1800);
          setTimeout(() => {
            setStatus('idle');
          }, 4200);
        }}
      >
        Seal this paper
      </PrimaryAction>
  );
}

function LiveKey() {
  const [state, setState] = useState<KeyTouchState>('idle');
  const [error, setError] = useState<unknown>(undefined);
  return (
    <KeyTouch
      state={state}
      purpose="to release your share"
      error={error}
      onUse={() => {
        setState('waiting');
        setError(undefined);
        const options = { publicKey: { challenge: new Uint8Array(32), allowCredentials: [], timeout: 15000, userVerification: 'required' } };
        navigator.credentials.get(options as CredentialRequestOptions).then(
          () => {
            setState('success');
          },
          (cause: unknown) => {
            setError(cause);
            setState('failed');
          },
        );
      }}
    />
  );
}

function Preview() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="pv">
      <RoleHeader role="Design system" exam="Preview" note="Every value is a specimen" />
      <div className="pv-themes" role="group" aria-label="Theme">
        {(
          [
            ['paper', 'Paper'],
            ['dark', 'Carbon paper'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            aria-pressed={theme === value}
            onClick={() => {
              setTheme(value);
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      <Section title="Logo" intro="A wax seal stamped PS. Flat and inline below 48px, the realistic seal from 48px up. Monochrome is always the flat mark.">
        <div className="pv-specimens">
          <Specimen title="Ink and seal red">
            <div className="pv-logos">
              {[16, 32, 48, 96].map((size) => (
                <Logo key={size} size={size} title={`Paper Seal logo at ${size.toString()}px`} />
              ))}
            </div>
          </Specimen>
          <Specimen title="Monochrome">
            <div className="pv-logos">
              {[16, 32, 48, 96].map((size) => (
                <Logo key={size} size={size} tone="mono" title={`Monochrome logo at ${size.toString()}px`} />
              ))}
            </div>
          </Specimen>
          <Specimen title="Wordmark">
            <div className="pv-logos">
              <Wordmark size={16} />
              <Wordmark />
              <Wordmark size={48} />
              <Wordmark tone="mono" />
            </div>
          </Specimen>
          <Specimen title="Favicon, on a dark tab">
            <div className="pv-tile">
              <img src="./favicon.svg" alt="SVG favicon at 16px" width={16} height={16} />
              <img src="./favicon.svg" alt="SVG favicon at 32px" width={32} height={32} />
              <img src="./favicon-32.png" alt="PNG fallback at 32px" width={32} height={32} />
              <img src="./apple-touch-icon.png" alt="Apple touch icon" width={90} height={90} />
            </div>
          </Specimen>
        </div>
      </Section>

      <Section title="Four screens" intro="State decides the screen. Each shows one next thing to do, then one sentence on what happens after it.">
        <div className="pv-screen">
          <RoleHeader role="Exam board" exam={SAMPLE_EXAM} />
          <Stage
            eyebrow="Before the exam"
            title="Publish the approved list"
            lede="Twelve people have registered their security keys. Publishing makes the list final."
            action={<PrimaryAction>Publish the list</PrimaryAction>}
            next="The sealed machine checks the list, then setters can send questions."
          />
        </div>
        <div className="pv-screen">
          <RoleHeader role="Setter" exam={SAMPLE_EXAM} />
          <Stage
            title="Question 14 is sealed"
            lede="No one, including you, can see which questions are chosen."
            action={<PrimaryAction status="done" doneLabel="Sealed">Submit</PrimaryAction>}
            next="Add another question, or stop here. Questions close on 4 Nov at 09:00."
            seal="sealed"
          />
        </div>
        <div className="pv-screen">
          <RoleHeader role="Exam centre" exam={SAMPLE_EXAM} note="Centre 4" />
          <Stage
            title="Unlock the paper"
            lede="The time seal has opened, and enough key holders have released."
            action={
              <KeyTouch
                state="idle"
                purpose="to open the paper"
                onUse={() => {
                  return;
                }}
              />
            }
            next="The paper opens on this computer, ready to print."
            seal="opening"
          />
        </div>
        <div className="pv-screen">
          <RoleHeader role="Key holder" exam={SAMPLE_EXAM} />
          <Stage
            title="Nothing to do until 09:59"
            lede="You hold one part of the key. It stays with you until the unlock."
            next="We’ll ask you to touch your security key when the time comes."
          >
            <Countdown at={LOADED_AT + 4 * 3600_000 + 1234_000} round={33700743} label="Your turn begins in" />
          </Stage>
        </div>
      </Section>

      <Section title="Seal" intro="The one signature. Once per screen at most. A seal of approval: it stays whole unless something went wrong, and holds still under reduced motion.">
        <div className="pv-specimens">
          <Specimen title="Try it">
            <LiveSeal />
          </Specimen>
          <Specimen title="Sealed">
            <Seal state="sealed" caption />
          </Specimen>
          <Specimen title="Opening">
            <Seal state="opening" caption />
          </Specimen>
          <Specimen title="Open">
            <Seal state="open" caption />
          </Specimen>
          <Specimen title="Broken">
            <Seal state="broken" caption />
          </Specimen>
          <Specimen title="Stamp">
            <Stamp>Sealed</Stamp> <Stamp tone="ink">Received</Stamp>
          </Specimen>
        </div>
      </Section>

      <Section title="Chain of custody" intro="The centrepiece of the verifier. Open a step to see its evidence. Hashes live here and nowhere earlier.">
        <Stepper steps={custody} />
      </Section>

      <Section title="Primary action">
        <div className="pv-specimens">
          <Specimen title="Press it">
            <LiveAction />
          </Specimen>
          <Specimen title="Busy">
            <PrimaryAction status="busy" busyLabel="Sealing the paper">
              Seal
            </PrimaryAction>
          </Specimen>
          <Specimen title="Done">
            <PrimaryAction status="done" doneLabel="Sealed">
              Seal
            </PrimaryAction>
          </Specimen>
          <Specimen title="Not available yet">
            <PrimaryAction disabled>Unlock the paper</PrimaryAction>
          </Specimen>
        </div>
      </Section>

      <Section title="Security key" intro="The live specimen makes a real browser request, so with no key it shows the real guidance.">
        <div className="pv-specimens">
          <Specimen title="Try it">
            <LiveKey />
          </Specimen>
          <Specimen title="Waiting">
            <KeyTouch
              state="waiting"
              onUse={() => {
                return;
              }}
            />
          </Specimen>
          <Specimen title="Success">
            <KeyTouch
              state="success"
              onUse={() => {
                return;
              }}
            />
          </Specimen>
          <Specimen title="Failed: no key">
            <KeyTouch
              state="failed"
              error={noKey}
              onUse={() => {
                return;
              }}
            />
          </Specimen>
        </div>
      </Section>

      <Section title="Checks, hashes and the clock">
        <div className="pv-specimens">
          <Specimen title="Check">
            <Rows>
              <Row label="Sample one">
                <Check status="pass" />
              </Row>
              <Row label="Sample two">
                <Check status="fail" />
              </Row>
              <Row label="Sample three">
                <Check status="pending" />
              </Row>
              <Row label="Sample four">
                <Check status="not-checked" />
              </Row>
            </Rows>
          </Specimen>
          <Specimen title="Hash">
            <Hash value={HASH} label="sample value" />
          </Specimen>
          <Specimen title="Countdown">
            <Countdown at={LOADED_AT + 2 * 86400_000 + 3723_000} round={33700743} label="Paper unlocks" />
          </Specimen>
          <Specimen title="Countdown, reached">
            <Countdown at={LOADED_AT - 1000} round={33700743} label="Paper unlocks" reached="The time seal is open" />
          </Specimen>
        </div>
      </Section>

      <Section title="Colour">
        <div className="pv-swatches">
          {SWATCHES.map(([name, token]) => (
            <div className="pv-swatch" key={token}>
              <span style={{ background: `var(${String(token)})` }} />
              {name}
              <br />
              <code>{token}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <div className="pv-type">
          <p style={{ fontFamily: 'var(--ps-serif)', fontSize: 'var(--ps-text-display)', lineHeight: 1.12 }}>Unlock the paper</p>
          <p style={{ fontFamily: 'var(--ps-serif)', fontSize: 'var(--ps-text-title)' }}>Title, in Libre Caslon Text</p>
          <p style={{ fontFamily: 'var(--ps-serif)', fontSize: 'var(--ps-text-section)' }}>Section, in Libre Caslon Text</p>
          <p>Body, in Public Sans. Clear at small sizes, and plain enough for instructions.</p>
          <p style={{ fontSize: 'var(--ps-text-small)' }}>Small, for notes and field hints.</p>
          <p className="ps-eyebrow">Eyebrow, for a step’s place in the flow</p>
          <p>
            <Mono>{HASH}</Mono>
          </p>
        </div>
      </Section>

      <Section title="Existing components" intro="Unmigrated screens keep working and pick up the look. New screens should use Stage.">
        <Screen title="Screen" lede="A title and a lede.">
          <Panel title="Panel">
            <Rows>
              <Row label="Row">
                <Badge tone="ok">Accepted</Badge>
              </Row>
              <Row label="Waiting row">
                <Badge tone="warn">Waiting</Badge>
              </Row>
              <Row label="Refused row">
                <Badge tone="bad">Refused</Badge>
              </Row>
              <Row label="Unset row" muted>
                <Badge tone="neutral">Not set</Badge>
              </Row>
            </Rows>
          </Panel>
          <EmptyState title="Empty state">Nothing has been published yet.</EmptyState>
          <Connected title="Connected" notConnected="Set the chain address." load={null}>
            {() => null}
          </Connected>
          <Panel title="A form">
            <Field
              label="Exam name"
              hint="As it appears on the paper."
              value=""
              onChange={() => {
                return;
              }}
            />
            <Field
              label="Exam date"
              error="Enter a date after today."
              value="Yesterday"
              onChange={() => {
                return;
              }}
            />
            <Button>Save</Button> <Button disabled>Not yet</Button>
          </Panel>
        </Screen>
      </Section>

    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
