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
4. **Plain words.** No crypto jargon on primary surfaces. See [Writing](#writing).
5. **Hashes only where they are evidence.** The exam board's address on the verifier is the one exception on a main view, because people compare it with what the board announces. A hash appears inside folded evidence on the verifier, or on a receipt someone may need to quote. It never appears on a primary surface.
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
    next="Setters can then send questions, usually about 20 minutes later."
  />
</Page>;
```

Every screen is this shape. Pick which `Stage` to show from state, with one component per state. `AppShell`, its nav and `Screen` are still exported, but no role's screen should use them.

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

The mark is a wax seal with a near-black `PS` monogram. It comes in two forms, chosen by size. Below 48px it is flat: one wax-coloured blob with the `PS` knocked out, drawn inline from `LOGO_SEAL` in `src/logoPaths.ts`. From 48px up it is the realistic bright seal in `src/assets/seal.svg`. The brand sources and earlier versions are in `presentation/assets/logo`, and v3 is the chosen one.

- `Logo` is the mark alone. `size` is in pixels. `title` is its accessible name, "Paper Seal" by default. Set `decorative` when the words sit beside it.
- `Wordmark` is the mark with "Paper Seal" in Libre Caslon Text. `size` is the mark's height and the words scale with it, so it follows the same size rule. The words are its accessible name.
- `tone` picks the flat mark's colour. The default fills it with `--ps-wax`, so it works on either theme. `tone="mono"` fills it with `currentColor`, for stamps, print and anywhere a second colour isn't available, and always uses the flat mark, whatever the size.
- Don't redraw it, outline it, recolour the realistic seal or add a shadow to the flat one. `Seal` shows the state of an exam with its own word and states, and is never used as a brand mark. `Logo` only says whose page this is.

`apps/*/public` holds `favicon.svg`, the flat `LOGO_SEAL` path on a paper tile in a brighter wax red, with `favicon-32.png` and `apple-touch-icon.png` rendered from it. `src/logo.test.tsx` checks that `favicon.svg` contains `LOGO_SEAL` exactly. If the mark changes, regenerate both PNGs.

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

`no-key` and `wrong-key` also show a one-line hint while `demo` is true: the demo's key is Chrome's virtual authenticator, a page cannot enable it, and `pnpm demo` opens Chrome with one attached to each person's window (one tab per person, since a virtual key belongs to a single tab). Pass `demo={false}` in production. The screens own that decision, so `packages/ui` doesn't depend on `@paperseal/protocol`.

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

`when` is a real clock time, such as `Sat 7 Nov, 21:30`, never a round number. `evidence` is a folded native `<details>`, so it needs no script and works from a keyboard. Put `Hash` and `Check` inside it. Set `aria-current` by giving one step the `current` state.

### `Seal`

The signature. `state` is `sealed`, `opening` or `open`. It closes, cracks and breaks as the state changes, so keep the same element mounted and change the prop. `caption` prints the state in words. `stamp` presses it down on mount. Use it at most once per screen, and only on a screen where the seal's state is the news.

| Exam state | Seal |
| --- | --- |
| Questions sealed, paper built, waiting for unlock | `sealed` |
| Paper unlocked, key holders releasing | `opening` |
| Paper decrypted at a centre, or opened to the public | `open` |

Only show a seal's state that the code has established. `Seal` is not evidence, and never show `sealed` as a stand-in for a check that hasn't run.

### `Stamp`

A rubber stamp for the single moment something finishes, such as `Sealed` or `Received`. `tone` is `seal` or `ink`, and `press` animates it in. Use it rarely. It is the only upper-cased text in the system.

### `Check`

The result of a check. `status` is `pass`, `fail`, `pending` or `not-checked`, and children give an optional reason. It always shows an icon and a word. Use it on the verifier in place of `Badge`.

### `Hash`

A shortened mono value. Clicking or tapping copies the whole value and prints it underneath, because a touch screen has no hover. Hovering shows the whole value. If copying fails it says so, and the printed value can be selected. Give it `label`, such as "paper fingerprint", for screen readers.

### `Countdown`

`at` is the moment in milliseconds, `label` says what the moment is and `reached` replaces the clock afterwards. It shows the time left and the clock time with its zone. `round` is still required by the type but is not shown.

It only displays. The round is the real clock, so convert with `roundTimeSeconds(round) * 1000` from `@paperseal/protocol`, and decide the flow from the round.

### Existing components

`Connected` (with `pollMs`), `Screen`, `Panel`, `Rows`, `Row`, `Badge`, `Button`, `Field`, `Mono`, `EmptyState`, `AppShell` and `ChromiumGate` keep their props and behaviour, and pick up the new look. Their class names are stable too, since `e2e/tests` selects `.ps-badge`.

- **`Connected`** is still the right way to read a real source. Note that it renders a `Panel` with a title, so it suits supporting content better than a whole `Stage`.
- **`Rows` and `Row`** are the ledger: use them for any short list of facts.
- **`Button`** is the secondary control, in ink. A screen may have several, or none.
- **`Badge`** remains for short tags. For a check's result, use `Check`.

## Writing

Write as a careful exam officer would, to teachers and centre staff who are not technical. The product owner's rule: make the copy simple, guide the person to the next step, and do not tell them what happens inside.

**Every screen answers "what do I do now?"** Lead with that, not with the reason. If there is nothing to do, say when to come back and whether it is safe to close the page. A screen where the person only waits still says what comes next, in one sentence.

- Use short sentences and everyday words, one idea each. Keep the voice calm. Use sentence case, and no exclamation marks, marketing or em dashes. "Sealed" is the one brand word and needs no celebration.
- Instructions start with the verb: "Publish the exam", "Open the paper". A button names the action in plain words, never "Submit" or "OK".
- `Stage` titles are never system nouns. "Open the paper", not "Unlock". "Nothing to do until 09:59", not "Status".
- Every error says what to do next, and never shows a raw technical message outside a folded details area. On the board, `withDetails` keeps the plain sentence first and folds the original message under "Details".
- Say nothing about what happens inside. Leave out TEE, attestation, hash, round, delta, Build, HPKE, Shamir, drand, RPC, instance key, list finality, timelock, PRF and read-back. Say what the person sees or does instead, and show real clock times, with weekday, date and zone, never round numbers.
- Keep roles by name: "exam board", "setter", "key holder" and "centre". Say what the person must do, and do not assume they know the system.
- Say "security key" every time. The demo's virtual key is explained only by `KeyTouch`'s one-line hint. Say "wallet" only where the board must confirm in it.
- Stay truthful. Do not say anything is checked or done unless the code does it. Permanent actions say so plainly, such as a name that cannot be changed once published. Keep warnings that protect someone, such as that closing a window or using another browser matters.
- Be precise about guarantees. Say "No one person can open the paper", not "impossible to leak". The README's Trust Assumptions set the limits.
- Explanations that help the curious go in the folded "details" areas. Hashes, rounds and evidence live there, and may use technical terms, but should still be readable. On the verifier, the main view is plain words and real times, and the evidence stays folded.

| Don't write | Write |
| --- | --- |
| Passkey, authenticator, WebAuthn, credential | Security key |
| TEE, enclave, attestation | Paper Seal; a check that it runs the published code, in details only |
| `K`, `K_priv`, Shamir share | The key, a part of the key |
| Timelock, drand, round | The time the paper unlocks, as a clock time |
| `T−Δ`, delta | Release time |
| Hash, commitment | Fingerprint, or leave it out |
| On-chain, transaction, RPC | The public record; receipt code |
| Neutral party | Key holder |
| Centre with a key / without a key | Centre holding part of the key / centre that gets the key when the paper unlocks |
| Approved list | The list of people for this exam |
| Reissue invite | Make a new link |
| Decrypt | Open |
| Threshold, 8-of-10 | "8 of the 10 key holders" |
| Bank | Question bank |

Technical names are allowed in folded evidence, where an expert expects them, and in the hints of the verifier's "Check it yourself" settings. Even there, lead with a plain label.

## Per-role flows

Each flow is a list of states. Each state is one `Stage`, and only the first unfinished one shows. The screen comes from the exam's state and this browser's stored credential, so a reload returns to the same place. The old paths still work as deep links, and land on the screen the state calls for. Detail such as fingerprints and rounds sits in a folded exam record.

### Board admin

`RoleHeader role="Exam board"`. The most steps, and the one role that handles forms.

Six steps, each with its number in the `Stage` eyebrow. The wallet is not a step: the action that needs it asks for it, and if the wallet is on another network it is asked to switch to Sepolia first. If it declines, the screen says what to do in the wallet. The form is kept in this browser until the exam is published, so a reload or a closed tab loses nothing.

1. **Create the exam:** one form for the name, time, length, topics and release time. Rounds and hashes are worked out, and setter limits, the closing time and the public record provider are folded under Advanced.
2. **Review and publish:** one summary and one action, "Publish the exam". The Paper Seal version is a row in the summary: the newest version whose tag checks out is already chosen, so there is nothing to click. "Use a different version" is folded under the summary. If the versions can't be loaded, or the tag does not match, the reason and a "Try again" show here and publishing stays shut. A correct read-back goes straight to step 3 with a "Published" `Stamp` banner above the invites, with the details folded. Only a read-back that does not match stops on a receipt, with "Start again".
3. **Invite people:** one invite per person. The board picks a role, types the name for the public list (a setter needs none, only an optional private note) and presses "Add invite", and a "Copy link" button appears on that row. The `Rows` then show each invite in one of four states, each with a word and a `Check` shape, never colour alone: waiting ("Waiting for them to register", with Copy link), registered ("Registered"), two keys on one invite ("Two security keys used this invite, so neither is on the list.", with "Make a new link"), and a registration that fits no invite ("Not invited", with the key's `Hash`). The list composes itself from the registered ones. The only choice left is a centre's place, a select of "Centre holding part of the key" or "Centre getting the key at unlock". Counts sit under "On the list". Primary action: post the approved list. Adding an invite is a plain `Button`, so the screen still has one red thing to press. Invites live in this browser only, so the panel says so, and "Save a backup" writes them to a file while "Restore from a backup" brings them back. The panel says the backup is private, because it holds the links. The invite secret stays in each link's fragment.

   The field is labelled "ENS name" for a key holder or centre, with the example `iit-delhi.eth` in its hint, and there are no plain names. Anything that is not an ENS name is refused with "Use an ENS name, like iit-delhi.eth.", and one that is not normalised with "Did you mean ...". The name is read on the chain before the invite is made. A name that does not exist is refused with a plain next step (create it, then add it again). When the chain can't be read the field says so and the button reads "Try again", and nothing stays blocked. A centre's name may be one the board issues under its own name. A waiting invite shows whether the name was found. A registered key holder with an ENS name shows one of: "Name confirmed" (the record matches their key), a failed `Check` and "Make a new link" when the record names another key (they stay off the list), or a pending `Check` saying the board is waiting for the name to be set up, with a plain "Go ahead without it" button. After that button the row says "On the list, but <name> is not confirmed", a `not-checked` `Check`, and "Wait for the name" undoes it. A centre's ENS name never holds the centre back, and its row says the name does not show that the centre is independent. A note says names are read on Sepolia, a test network, and prove nothing there. Wording keeps to the Writing rules: say "name", "security key" and "set up", never "record hash", "RPC" or "resolve" outside Details.
4. **Questions are coming in:** a wait screen with a `Countdown` to the closing time. It says the board must come back after that time to post the paper's record, and that it is safe to close the page until then.
5. **The paper is ready:** one action, "Post the paper's record". Nothing else competes with it.
6. **Status:** `seal` follows the unlock and end rounds, with `stampSeal` once the paper's record is posted, and the count of key holders released. It links the public verifier when `VITE_VERIFIER_URL` is set, and "Copy public link" copies the verifier's share link, `<verifier URL>/?exam=<examId>` (see `spec/agent-verification.md`), so it names the exam.

### Setter

`RoleHeader role="Setter"`. Phone-friendly, and quick to repeat.

1. **Register:** opens from the invite link. The role is in the link, so nothing is typed, and the only control is `KeyTouch` to register the security key. Next: wait for the board's list. Without a valid link it shows a plain explanation and no form.
2. **Nothing to do yet:** a wait screen whose wording follows whether the board has posted the list. The page opens for writing by itself.
3. **Check the machine:** runs by itself, with nothing to press, and runs again at about four minutes while the page is open, so a slow writer never meets the five minute limit. If it fails, sealing stops and the writing stays on the page.
4. **Add a question:** the form, with a `PrimaryAction` to seal it. Each question needs one touch, and receipts build up on the same page. A choice of Written or Multiple choice sits above the writing area, with Written already picked, so a written question costs no extra click. Multiple choice shows two lettered option fields, with Add an option up to the limit in `spec/constants.json` and Remove once there are more than the minimum. A blank or repeated option is called out beside its field in plain words, and sealing stays shut until it is fixed. There is no field for the correct answer: one short line says the answer key isn’t sent, because the paper becomes public. Options are trimmed and sent in the order shown.
5. **Closed:** a wait screen. After the Build, the check that the same machine built the paper appears as one `Check`.

### Centre

`RoleHeader role="Exam centre" note={centreName}`. Used under pressure on exam day, so this is the simplest of all.

1. **Register:** opens from the invite link, which holds the centre's name, so there is no form field. It shows the name and `KeyTouch`, and reads left-aligned, because it is the one centre screen that is a form. Once the exam has ended, the page shows "This exam has ended" and offers no registration.
2. **Ready:** a wait screen, `seal="sealed"`, with a `Countdown` to unlock. The paper downloads and is checked against the Build by itself, and the result shows as one `Check`. A `PrimaryAction` appears only if that check fails.
3. **Release, for centres holding a part of the key:** `KeyTouch` with `purpose="to release your part of the key"`, `seal="opening"`. The checks that need no key run as soon as the page is ready, so the press goes straight to the touch, and any that are older than a minute run again at the press. The touch never starts without a press. If the release is refused, the screen shows no seal. Centres without a part of the key skip this.
4. **Waiting for key holders:** a wait screen with the release count, for a centre with nothing to release.
5. **Unlock:** `KeyTouch` with `purpose="to open the paper"`, `seal="opening"`. The time seal and the centre's sealed key are got ahead of the press, and got again at the press if they are older than two minutes.
6. **Open:** `seal="open"`. The action is to view or print the paper. The unlock log is in `children`. A multiple choice question shows its options under it as a lettered list (A, B, C) in the paper’s order, set for print. A written question has no list. The verifier page shows the published paper the same way.
7. **Hand out the paper:** the step after Open, kept in this page's memory next to the paper, so nothing about how the paper is held changes. "The paper is open" has "Hand out the paper" as its one primary action, with "Print the paper" as a plain button. The hand out screen shows the opened paper below, and above it a list of rooms (Room 1 to 3 to start, "Add a room" up to 20) each with a copies field from 1 to 999. A bad number is called out beside its room and keeps sending shut. The primary action "Send to the rooms" marks the rooms one after another, each with a word and a `Check`: "Not sent", "Sending", "Marked as sent (demo)". Delivery is simulated. The screen always carries the label "Demo: nothing is sent to any room", and no copy on it may say a room has, got or was delivered the paper. Changing a room's number puts it back to "Not sent". Print stays on the screen. When delivery is real this step changes, and the label goes only then.

### Opening a link outside Chrome

A link opened from email, WhatsApp or Safari shows "Open this page in Chrome", with a "Copy link" button that copies the whole address, including its fragment, to paste into Chrome.

### Neutral key holder

`RoleHeader role="Key holder"`. Nearly always a wait, then one touch.

1. **Register:** opens from the invite link, which holds the name, so nothing is typed. `KeyTouch` only. Once the exam has ended, the page shows "This exam has ended" and offers no registration. A key holder invited under their own ENS name also gets a "Confirm your name" panel after registering, on this page and the waiting screens that follow. It holds one line ("add a text record named paperseal.passkey to it, with this value"), the exact value in monospace and a "Copy the value" button. Nothing waits on it, and a plain name gets no panel.
2. **Waiting:** "Nothing to do until 09:59", with a `Countdown`.
3. **Release:** `KeyTouch` with `purpose="to release your part of the key"`, `seal="opening"`. The checks that need no key run before the press, as for a centre.
4. **Done:** `Stamp` "Released". Next: the paper reaches centres once enough key holders have released. Never say a neutral key holder receives or can see the paper.

### Public verifier

`RoleHeader role="Public record" exam={exam.name}`. There is no primary action and no sign-in, so the page is a single `Stepper`, with a sentence at the top saying where the exam has got to.

1. Lead with a plain-language verdict, for example "This exam is on track. Nothing has failed so far."
2. Show one `Stepper` for the whole chain: exam published, Paper Seal runs the published code, people approved, questions closed, paper built and sealed, key holders released, paper unlocks for centres, paper opens to everyone.
   On a `#/name/` link, the `Stepper` starts with a Name step. Until it passes, every later step waits, nothing about the exam is read, and no seal shows. Its exact reasons stay in the evidence.
   In the people step's evidence, each key holder or centre whose name is an ENS name shows a badge: "Name confirmed" when the name's record matches their security key, otherwise "Not confirmed" for a key holder and "Label only" for a centre, with one plain line why ("has no record for this security key yet", "names a different security key", "could not be read just now"). These are labels, never failing checks, so they never reach the failure banner. A note under them says a centre's name is one the board can change, and the Sepolia line says a similar name can be registered by anyone.
3. Put the existing evidence (`Attestation`, `Commitments`, `Proof`) inside each step's `evidence`, with `Check` and `Hash`.
4. A check not yet run is `Not checked`. A step that doesn't apply is `not-applicable`. If demo mode is on, because `requireHardwareAttestation` is false, say so visibly as a `note` in plain words: this is a demonstration and the security keys are simulated.
5. The connection settings stay at the foot of the page, under "Check it yourself".
6. The first exam step fails if the address does not run the published contract, or the exam's times are outside the allowed limits. Nothing else is read from such an address, and the headline says it is not a Paper Seal exam record. When the code matches, the step's note names the exam board's account.
7. A warning sits under the failure banner, quieter than it, and never counts as a failed check. There are two: the paper was recorded after its unlock time, and a name leads to a different exam record from the one the page is set up to read. The name warning shows as soon as the name is read, and the Name step keeps its line about Sepolia.
8. The folded evidence for "Paper Seal runs the published code" also shows how the public record is read (`chain.readBlock`).
