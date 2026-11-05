# Paper Seal Design System

This is the brief for anyone building a Paper Seal screen. The components live in `packages/ui`.

To see everything rendered, run `pnpm --filter @paperseal/ui preview` and open <http://localhost:5179>. The page has the logo, both themes, every component state and four sample screens. `pnpm --filter @paperseal/ui preview:build` writes the same page as static files to `packages/ui/preview/dist`.

## The idea

**An official document under seal.** Paper Seal should feel like a sealed envelope from an examination office: warm paper, deep ink, ledger rules and one piece of red wax. The people using it are exam officers and invigilators, not crypto users. They should feel that something careful and official is happening, and they should always know what to do next.

It must not look like a dashboard or a crypto app. That rules out purple gradients, glassmorphism, cards inside cards, grey rounded boxes, tab bars and walls of hashes.

## Principles

1. **One primary action per screen.** If a screen seems to need two, it is two screens, or one of them is not primary.
2. **The fewest clicks.** Do what can be done without asking. Skip any step the system can work out, and never ask someone to confirm something they cannot judge.
3. **State decides the screen, not tabs.** Read the exam's state and show the one screen it calls for. Nobody chooses where to go, and there is no navigation to learn.
4. **Plain words.** No crypto jargon on primary surfaces. See [Copy rules](#copy-rules).
5. **Hashes only where they are evidence.** A hash appears inside folded evidence on the verifier, or on a receipt someone may need to quote. It never appears on a primary surface.
6. **Always say what happens next.** Every screen, including a screen where the person only waits, ends with one sentence on what comes next.
7. **Never fake it.** A check that has not run shows `Not checked`. An unfinished flow shows that it is unfinished. A screen must never imply more certainty than the code has.

## Using it

```tsx
import '@paperseal/ui/tokens.css'; // once, in the app's entry file

import { Page, PrimaryAction, RoleHeader, Stage } from '@paperseal/ui';

<Page header={<RoleHeader role="Exam board" exam={exam.name} />}>
  <Stage
    title="Publish the approved list"
    lede="Twelve people have registered their security keys. Publishing makes the list final."
    action={<PrimaryAction onClick={publish} status={status} busyLabel="Publishing">Publish the list</PrimaryAction>}
    next="The sealed machine checks the list, then setters can send questions."
  />
</Page>;
```

Every screen is this shape. Pick which `Stage` to show from state, with one component per state. `AppShell`, its nav and `Screen` remain for unmigrated screens. Migrated screens should not use them.

## Tokens

All tokens are CSS custom properties in `packages/ui/src/tokens.css`. Use the tokens and never a raw colour. `src/tokens.test.ts` checks the contrast of each text colour against each background, so a colour change that breaks AA fails the tests.

### Colour

| Token | Paper | Carbon paper | Use |
| --- | --- | --- | --- |
| `--ps-paper` | `#f3ecdf` | `#12141b` | Page background |
| `--ps-paper-deep` | `#e8dfcd` | `#1c1f29` | Hover, notes, disabled fill |
| `--ps-field` | `#fbf7ee` | `#1c1f29` | Inside form inputs |
| `--ps-ink` | `#191a23` | `#ece5d6` | Text, strong rules, focus ring |
| `--ps-ink-soft` | `#544e45` | `#aea897` | Secondary text |
| `--ps-rule` | `#cbbfa8` | `#363946` | Hairlines between rows, decorative only |
| `--ps-rule-strong` | `#85796a` | `#7f818c` | Control edges, 3:1 against paper |
| `--ps-wax` | `#96191f` | `#bd3633` | The seal and the primary action's fill |
| `--ps-wax-deep` | `#6b0e14` | `#6e1419` | Wax shadow, hover |
| `--ps-wax-shine` | `#c8504a` | `#dd6f64` | Highlight on the seal only |
| `--ps-on-wax` | `#fff6e8` | `#fff6e8` | Text on wax |
| `--ps-seal-ink` | `#8f1a1f` | `#f0877a` | Red text and small marks |
| `--ps-pass` | `#1b5a3e` | `#86d0a8` | Pass, done |
| `--ps-pending` | `#75500a` | `#e2b868` | Pending, waiting |
| `--ps-fail` | `#a12f00` | `#ff9a70` | Fail, failed |

**Wax is rationed.** On any one screen, wax appears on the seal, the primary action, the current step and the logo. It never decorates. A plain `Button` is ink, so a screen with several controls still has one red thing to press.

**Fail is not wax.** Fail is a vermilion, more orange than the seal, because a seal is good news and a failure is not. Colour never carries the difference alone: `Check` and `Stepper` always add a word and a different shape.

### Themes

Paper is the theme. It applies whatever the operating system prefers, and `color-scheme` is `light`. Carbon paper is only available by setting `data-theme="dark"` on `<html>` yourself. Nothing in the system switches to it, and the apps have no theme toggle.

### Type

There are three self-hosted families, each pinned to an exact `@fontsource` version in `packages/ui/package.json` and loaded by `src/fonts.css`. Their files ship inside the build, so a board-hosted site calls no third party. `src/tokens.test.ts` checks this.

| Family | Token | Use | Why |
| --- | --- | --- | --- |
| Libre Caslon Text | `--ps-serif` | Headings, step labels | The printed voice of gazettes and certificates |
| Public Sans | `--ps-sans` | Everything else | Strong and neutral, designed for government services |
| IBM Plex Mono | `--ps-code` | Hashes, times, the countdown | Clear `0`/`O` and `1`/`l`, and it keeps a typewriter's feel |

| Token | Size | Family | Use |
| --- | --- | --- | --- |
| `--ps-text-display` | 32–46px, fluid | Serif, 1.12 line height | `Stage` title |
| `--ps-text-title` | 28px | Serif | Older `Screen` titles, reached state of `Countdown` |
| `--ps-text-section` | 20px | Serif | Section headings, `KeyTouch` title |
| `--ps-text-body` | 16px | Sans, 1.55 line height | Body |
| `--ps-text-small` | 14px | Sans | Notes, hints, labels |
| `--ps-text-code` | 13px | Mono | Hashes and times |

Don't add weights: Caslon has 400 and 700, Public Sans has 400, 500 and 600, and Plex Mono has 400 and 500. Public Sans has no small capitals, so don't use `font-variant-caps`. Don't upper-case text with CSS, apart from `Stamp`.

### Spacing

Spacing sits on a 4px grid: `--ps-space-1` to `--ps-space-8` are 4, 8, 12, 16, 24, 32, 48 and 64px. Keep related things 8–16px apart and separate groups by 32px or more. Use a hairline only where it does a job.

### Shape and rules

- **Corners** are square. `--ps-radius` is 2px, and only buttons use it.
- **No boxes.** A group of content is marked by a rule above it, never a card. `Panel` is a ruled section, so nesting stays flat.
- **Ledger rules:** a double ink rule under the header, a 1px ink rule above a section and a 1px `--ps-rule` between rows.
- **No shadows,** apart from the wax itself.

### Motion

| Token | Value | Use |
| --- | --- | --- |
| `--ps-time-quick` | 140ms | Hover and press |
| `--ps-time-seal` | 720ms | The seal breaking or closing |
| `--ps-ease-settle` | slight overshoot | Wax settling |

Motion is for the seal and for waiting on a security key. Under `prefers-reduced-motion`, all animation and transitions stop. Every state still shows in full, because state is never carried by movement.

### Accessibility

- AA contrast in both themes, enforced by tests.
- A 2px ink focus ring on everything, from `:focus-visible`.
- Touch targets of at least 44px for primary controls and inputs.
- Status is always in words, and status changes are announced through `role="status"` or `role="alert"`.
- Everything works from 320px wide, with a 16px gutter and no sideways scrolling.

## Components

### `Logo` and `Wordmark`

The mark is an exam paper with its corner folded down and closed by wax. The paper is pure geometry on a 32-unit grid: every horizontal and vertical edge lands on a whole pixel at 16px and 32px, and the fold is an exact 45 degrees. The wax's uneven edge is the only organic line.

- `Logo` is the mark alone. `size` is in pixels, and multiples of 16 are the crispest. `title` is its accessible name, "Paper Seal" by default. Set `decorative` when the words sit beside it.
- `Wordmark` is the mark with "Paper Seal" in Libre Caslon Text. `size` is the mark's height and the words scale with it. The words are its accessible name.
- The sheet is `currentColor` and the wax is `--ps-wax`, so it works on either theme. `tone="mono"` makes both `currentColor`, for stamps, print and anywhere a second colour isn't available.
- Don't redraw it, outline it, add a shadow or put the seal's `PS` on it. `Seal` tells the state of an exam. `Logo` only says whose page this is.

`apps/*/public` holds `favicon.svg`, on a paper tile so the fold survives a dark browser tab, with `favicon-32.png` and `apple-touch-icon.png` rendered from it. `src/logo.test.tsx` checks that `favicon.svg` repeats the paths in `src/logoPaths.ts` exactly. If the mark changes, regenerate both PNGs.

### `RoleHeader`

The single quiet header. It starts with the `Wordmark`. `role` is the person's role, `exam` the exam's name, and `note` an optional short remark such as the centre's name. It has no links and no tabs.

### `Page`

The page frame. Takes `header` and one `Stage` as children, and provides `<main>`. Without a `header` it shows the `Wordmark` alone.

### `Stage`

The core pattern.

| Prop | Required | Meaning |
| --- | --- | --- |
| `title` | Yes | The next thing to do as a plain instruction, or the state now as a plain statement |
| `next` | Yes | One sentence on what happens next |
| `action` | No | One control: a `PrimaryAction` or `KeyTouch`. Leave it out if the person only waits |
| `lede` | No | At most two sentences of context |
| `eyebrow` | No | A small line above the title, such as "Before the exam" |
| `seal` | No | Shows the `Seal` in this state |
| `stampSeal` | No | Presses the seal down as the screen appears. Use only for the moment something was sealed |
| `children` | No | Supporting content below: a `Countdown`, a `Stepper` or a few `Rows` |

### `PrimaryAction`

The only wax control. `status` is `idle`, `busy` or `done`. Give it `busyLabel` and `doneLabel` in plain words, such as "Publishing" and "Published". While busy or done it stays focusable and ignores presses. Use `disabled` only for an action that isn't available yet, and say why in the `lede`.

### `KeyTouch`

The security key prompt, which goes in `Stage`'s `action`. Run the WebAuthn request from `onUse` and move `state` through it:

```tsx
const [state, setState] = useState<KeyTouchState>('idle');
const [error, setError] = useState<unknown>();

const onUse = () => {
  setState('waiting');
  release().then(
    () => setState('success'),
    (cause: unknown) => {
      setError(cause);
      setState('failed');
    },
  );
};

<KeyTouch state={state} error={error} purpose="to release your share" onUse={onUse} demo={!requireHardwareAttestation} />;
```

`error` picks the guidance, using `securityKeyProblem(error)`:

| Problem | Comes from | Shows |
| --- | --- | --- |
| `no-key` | `NotAllowedError`, `NotSupportedError`, `AbortError`, `TimeoutError` | How to plug in a key and retry. A browser reports Cancel and "no key" identically, so this wording covers both |
| `wrong-key` | `KeyError` codes `prf_unavailable`, `synced_passkey`, `unsupported_key` | Use the registered physical key |
| `unsupported` | No `navigator.credentials`, or `SecurityError` | Open it in Chrome over https |
| `other` | Anything else | A general retry. Pass `failureText` to explain it properly |

Pass `failureText` whenever the screen knows better, such as "This key is not on the approved list."

`no-key` and `wrong-key` also show a one-line hint while `demo` is true: the demo's key is Chrome's virtual authenticator, a page cannot enable it, and it is set up in DevTools → WebAuthn. Pass `demo={false}` in production. The screens own that decision, so `packages/ui` doesn't depend on `@paperseal/protocol`.

### `Stepper`

The chain of custody, and the centrepiece of the verifier. Pass `steps`, each with `id`, `label`, `state`, and optionally `when`, `note` and `evidence`.

| State | Marker | Word |
| --- | --- | --- |
| `done` | Solid ink disc with a tick | Done |
| `current` | Wax ring with a dot | In progress |
| `waiting` | Empty ring, dashed rail | Waiting |
| `failed` | Square with a cross | Failed |
| `not-applicable` | Dashed ring with a dash | Not applicable |

It reads as a ledger: `when` on the left, then the rail, then the label. On phones `when` folds above the label. It is a vertical list at every width because evidence opens downwards, and that wouldn't work on a horizontal track.

`when` is a timestamp or a round, such as `Round 33,700,743`. `evidence` is a folded native `<details>`, so it needs no script and works from a keyboard. Put `Hash` and `Check` inside it. Set `aria-current` by giving one step the `current` state.

### `Seal`

The signature. `state` is `sealed`, `opening` or `open`. It closes, cracks and breaks as the state changes, so keep the same element mounted and change the prop. `caption` prints the state in words. `stamp` presses it down on mount. Use it at most once per screen, and only on a screen where the seal's state is the news.

| Exam state | Seal |
| --- | --- |
| Questions sealed, paper built, waiting for unlock | `sealed` |
| Time seal open, key holders releasing | `opening` |
| Paper decrypted at a centre, or opened to the public | `open` |

Only show a seal's state that the code has established. `Seal` is not evidence, and never show `sealed` as a stand-in for a check that hasn't run.

### `Stamp`

A rubber stamp for the single moment something finishes, such as `Sealed` or `Received`. `tone` is `seal` or `ink`, and `press` animates it in. Use it rarely. It is the only upper-cased text in the system.

### `Check`

The result of a check. `status` is `pass`, `fail`, `pending` or `not-checked`, and children give an optional reason. It always shows an icon and a word. Use it on the verifier in place of `Badge`.

### `Hash`

A shortened mono value. Clicking or tapping copies the whole value and prints it underneath, because a touch screen has no hover. Hovering shows the whole value. If copying fails it says so, and the printed value can be selected. Give it `label`, such as "paper fingerprint", for screen readers.

### `Countdown`

`at` is the moment in milliseconds, `round` is the drand round due then, `label` says what the moment is and `reached` replaces the clock afterwards. It shows the time left, the clock time and `Public clock round 33,700,743`.

It only displays. The round is the real clock, so convert with `roundTimeSeconds(round) * 1000` from `@paperseal/protocol`, and decide the flow from the round.

### Existing components

`Connected` (with `pollMs`), `Screen`, `Panel`, `Rows`, `Row`, `Badge`, `Button`, `Field`, `Mono`, `EmptyState`, `AppShell` and `ChromiumGate` keep their props and behaviour, and pick up the new look. Their class names are stable too, since `e2e/tests` selects `.ps-badge`.

- **`Connected`** is still the right way to read a real source. Note that it renders a `Panel` with a title, so it suits supporting content better than a whole `Stage`.
- **`Rows` and `Row`** are the ledger: use them for any short list of facts.
- **`Button`** is the secondary control, in ink. A screen may have several, or none.
- **`Badge`** remains for short tags. For a check's result, use `Check`.

## Copy rules

Write as a careful exam officer would. Use short sentences and active verbs. Instructions start with the verb: "Publish the list", "Unlock the paper".

| Don't write | Write |
| --- | --- |
| Passkey, authenticator, WebAuthn, credential | Security key |
| TEE, enclave, attestation | Sealed machine; proof it's running the published code |
| `K`, `K_priv`, Shamir share | Key, part of the key |
| Timelock, drand | Time seal; public clock |
| `T−Δ` | Unlock time |
| Hash, commitment | Fingerprint, or leave it out |
| On-chain, transaction | Published; public record |
| Decrypt | Open, unlock |
| Threshold, 8-of-10 | "8 of the 10 key holders" |
| Bank | Question bank |

- Technical names are allowed in folded evidence, where an expert expects them, and on the verifier's Connection screen. Even there, lead with a plain label.
- Button labels name the outcome: "Publish the list", not "Submit" or "OK".
- `Stage` titles are never system nouns. "Unlock the paper", not "Unlock". "Nothing to do until 09:59", not "Status".
- Errors say what happened and what to do. "This key is not on the approved list. Contact your exam board." Never show a raw error on a primary surface.
- Waiting screens say what they're waiting for and when it ends.
- Say "security key" every time. The demo's virtual key is explained only by `KeyTouch`'s one-line hint.
- Use sentence case. Avoid exclamation marks. "Sealed" needs no celebration.
- Be precise about guarantees. Say "No one person can open the paper", not "impossible to leak". The README's Trust Assumptions set the limits.

## Per-role flows

Each flow is a list of states. Each state is one `Stage`, and only the first unfinished one shows. The screen comes from the exam's state and this browser's stored credential, so a reload returns to the same place. Everything that exists today, such as blueprint forms or the unlock log, stays available, but as the content of a state rather than a tab.

### Board admin

`RoleHeader role="Exam board"`. The most steps, and the one role that handles forms.

1. **Connect:** connect the wallet. Next: set up the exam.
2. **Set up the exam:** blueprint, then schedule. Each is one form with one primary action, and `Field`s are grouped in ruled sections.
3. **Bring people on:** share the sign-up links. The `Rows` list who has registered, with a count. Primary action: "Publish the approved list".
4. **Post what the machine signed:** each outbox message is one `Stage` with "Post to the public record". Nothing else competes with it.
5. **Questions are coming in:** a wait screen with a `Countdown` to lock.
6. **Sealed:** `seal="sealed"` with `stampSeal` once the Build is posted.
7. **Unlock day:** a wait screen with `Countdown`, then a `Stepper` of what's happening.

### Setter

`RoleHeader role="Setter"`. Phone-friendly, and quick to repeat.

1. **Register:** `KeyTouch` to register the security key. Next: wait for the board's list.
2. **Waiting to be approved:** a wait screen.
3. **Sign in:** `KeyTouch`.
4. **Add a question:** the form, with `PrimaryAction` "Seal this question". Each question needs one touch.
5. **Sealed:** `seal="sealed"` with `stampSeal` and the receipt. The receipt's `Hash` can sit in `children`, because it is something a setter may need to quote. The action is "Add another question".
6. **Closed:** a wait screen. After the Build, the check that the same machine built the paper appears as one `Check`.

### Centre

`RoleHeader role="Exam centre" note={centreName}`. Used under pressure on exam day, so this is the simplest of all.

1. **Register:** `KeyTouch`.
2. **Download:** `PrimaryAction` "Download the sealed paper". The check against the Build happens by itself and shows as one `Check`.
3. **Ready:** a wait screen, `seal="sealed"`, with a `Countdown` to unlock.
4. **Release, for centres holding a part of the key:** `KeyTouch` with `purpose="to release your part of the key"`, `seal="opening"`. Centres without one skip this.
5. **Unlock:** `KeyTouch` with `purpose="to open the paper"`, `seal="opening"`.
6. **Open:** `seal="open"`. The action is to view or print the paper. The unlock log is in `children`.

### Neutral key holder

`RoleHeader role="Key holder"`. Nearly always a wait, then one touch.

1. **Register:** `KeyTouch`.
2. **Waiting:** "Nothing to do until 09:59", with a `Countdown`.
3. **Release:** `KeyTouch` with `purpose="to release your part of the key"`, `seal="opening"`.
4. **Done:** `Stamp` "Released". Next: the paper reaches centres once enough key holders have released. Never say a neutral key holder receives or can see the paper.

### Public verifier

`RoleHeader role="Public record" exam={exam.name}`. There is no primary action and no sign-in, so the page is a single `Stepper`, with a sentence at the top saying where the exam has got to.

1. Lead with a plain-language verdict, for example "This exam is on track. Nothing has failed so far."
2. Show one `Stepper` for the whole chain: code published, machine proof, approved list, paper sealed and published, time seal, key holders released, unlock, full proof.
3. Put the existing evidence (`Attestation`, `Commitments`, `Proof`) inside each step's `evidence`, with `Check` and `Hash`.
4. A check not yet run is `Not checked`. A step that doesn't apply is `not-applicable`. If demo mode is on, because `requireHardwareAttestation` is false, say so visibly as a `note` in plain words: this is a demonstration and the security keys are simulated.
5. The Connection settings stay as a quiet link at the foot of the page.
