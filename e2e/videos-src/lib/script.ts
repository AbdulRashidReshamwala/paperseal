import type { Locator, Page } from 'playwright-core';

import type { Actor } from '../../ui/kit';
import type { World } from './world';

/*
 * What a video file is written in. A video is a list of steps, and a step is the caption for that
 * moment and what to do in it. `wait` marks the time spent on something slow, such as a block being
 * mined: the step runs in full, and the cut keeps only its start and end.
 */

export interface Stage {
  page: Page;
  board: Actor;
  world: World;
  /** A label nobody has used: the video's `prefix` and the time as HHMM. */
  label: string;
  /** Moves to the control, lets the viewer see it, and clicks it. */
  click: (target: Locator) => Promise<void>;
  /** Moves to the field and types at a speed a viewer can follow. */
  type: (target: Locator, text: string) => Promise<void>;
  /** Brings something into the middle of the view. */
  show: (target: Locator) => Promise<void>;
  /** Waits, so the viewer can read the screen. */
  hold: (ms: number) => Promise<void>;
  /** Ends the finished video on this moment. Later steps still run, off camera, and can fail the run. */
  endHere: () => Promise<void>;
  /** Lines for the report, such as an exam ID. */
  notes: Record<string, string>;
}

export interface Step {
  /** The caption. A function can use what earlier steps found. */
  say: string | ((stage: Stage) => string);
  run: (stage: Stage) => Promise<void>;
  /** How long the screen stays after the step, in milliseconds. */
  hold: number;
  wait: boolean;
  /** Sends a transaction. `--dry` stops before the first such step. */
  spends: boolean;
}

export interface Video {
  title: string;
  /** The start of the unique label. */
  prefix: string;
  /** The app's route to open. `ready` runs off camera, and what it leaves on screen is the video's first frame. */
  open: string;
  ready: (stage: Stage) => Promise<void>;
  /** Throwing in a step fails the run, so a step that reads the outcome from where it really is is an assertion. */
  steps: Step[];
}

export const defineVideo = (video: Video): Video => video;

export const step = (say: Step['say'], run: Step['run'], options: { hold?: number; spends?: boolean } = {}): Step => ({
  say,
  run,
  hold: options.hold ?? 700,
  wait: false,
  spends: options.spends ?? false,
});

export const wait = (say: Step['say'], run: Step['run'], options: { hold?: number; spends?: boolean } = {}): Step => ({
  ...step(say, run, options),
  wait: true,
});
