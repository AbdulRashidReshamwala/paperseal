import type { Locator, Page } from 'playwright-core';

import type { Actor } from '../../ui/kit';
import type { World } from './world';

/*
 * What a video file is written in. A video is a list of steps, and a step is the caption for that
 * moment and what to do in it. `wait` marks the time spent on something slow, such as a block being
 * mined: the step runs in full, and the cut keeps only its start and end.
 */

export interface Stage {
  /** The window on camera. */
  page: Page;
  actor: Actor;
  /** The board's window. It is the one on camera unless the video names a `persona`, and then it stays off camera. */
  office: Stage;
  world: World;
  /** A label nobody has used: the video's `prefix` and the time as HHMM. */
  label: string;
  /** Moves to the control, lets the viewer see it, and clicks it. */
  click: (target: Locator) => Promise<void>;
  /** Moves to the field and types at a speed a viewer can follow. */
  type: (target: Locator, text: string) => Promise<void>;
  /** Scrolls only as far as it takes to bring something clear of the caption. */
  show: (target: Locator) => Promise<void>;
  /** Goes back to the top of the page. */
  top: () => Promise<void>;
  /** Waits, so the viewer can read the screen. */
  hold: (ms: number) => Promise<void>;
  /** Ends the finished video on this moment. Later steps still run, off camera, and can fail the run. */
  endHere: () => Promise<void>;
  /** Lines for the report, such as an exam ID. */
  notes: Record<string, string>;
  /** Passed between steps and never printed, such as an invite link, which holds a secret. */
  memo: Record<string, string>;
}

export interface Step {
  /** The caption. A function can use what earlier steps found. */
  say: string | ((stage: Stage) => string);
  run: (stage: Stage) => Promise<void>;
  /** How long the screen stays after the step, in milliseconds. A step that ends on a new page leaves this at 0, so the next caption comes with that page. */
  hold: number;
  wait: boolean;
  /** For a `wait`: seconds kept at its start and end. [0, 0] removes it from the video altogether. */
  keep?: readonly [number, number];
  /** Sends a transaction. `--dry` stops before the first such step. */
  spends: boolean;
}

export interface Video {
  title: string;
  /** How much faster than real time the finished video plays. */
  speed?: number;
  /** The start of the unique label. */
  prefix: string;
  /** The demo person the window on camera acts as. Without it the board is on camera. */
  persona?: string;
  /** Runs off camera before anything opens on camera. */
  setup?: (stage: Stage) => Promise<void>;
  /** With `--resume=<label>`, runs instead of `setup`, to finish an exam a stopped run left behind. */
  resume?: (stage: Stage) => Promise<void>;
  /** The app's route to open. `ready` runs off camera, and what it leaves on screen is the video's first frame. */
  open: string | ((stage: Stage) => string);
  ready: (stage: Stage) => Promise<void>;
  /** Throwing in a step fails the run, so a step that reads the outcome from where it really is is an assertion. */
  steps: Step[];
}

export const defineVideo = (video: Video): Video => video;

export const step = (say: Step['say'], run: Step['run'], options: { hold?: number; spends?: boolean } = {}): Step => ({
  say,
  run,
  hold: options.hold ?? 0,
  wait: false,
  spends: options.spends ?? false,
});

export const wait = (say: Step['say'], run: Step['run'], options: { hold?: number; spends?: boolean; keep?: readonly [number, number] } = {}): Step => ({
  ...step(say, run, options),
  wait: true,
  ...(options.keep ? { keep: options.keep } : {}),
});
