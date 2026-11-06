import type { Page } from 'playwright-core';

/*
 * The one place that knows the app's words. A separate change is rewriting the copy in apps/ and
 * packages/ui, so every exact string the suite relies on is here, and tests use these names. Prefer
 * roles (button, heading, radio, textbox) with a name from this file over text matches in a test.
 *
 * Exact-text selectors that cannot be avoided are the ones whose label IS the control's name:
 * field labels, button names and the headings that name a screen. They are all below.
 */

export const text = {
  // Board
  createHeading: 'Create the exam',
  versionHeading: 'Choose what the sealed machine runs',
  reviewHeading: 'Review and publish',
  peopleHeading: 'Bring people in',
  publishedHeading: 'The exam is published',
  recordBuildHeading: 'Record the sealed paper',
  wrongAccount: /not the board address/i,
  // Shared
  keyRegisteredHeading: 'Your security key is registered',
  linkProblemHeading: /This invitation link doesn.t work/,
  openLinkHeading: 'Open your invitation link',
  endedHeading: 'This exam has ended',
  // Setter
  writeHeading: 'Write a question',
  composerBlockedHeading: /We can.t confirm this is the genuine sealed system/,
  // Release
  releaseHeading: 'Release your share',
  releaseFailedHeading: 'Your share was not released',
};

export const field = {
  examName: 'Exam name',
  examStart: 'Date and time of the exam',
  length: 'Length, in minutes',
  releaseMinutes: 'Minutes before the exam to release the paper to centres',
  topicName: (n: number) => `Topic ${String(n)} name`,
  topicQuestions: (n: number) => `Topic ${String(n)} questions`,
  maxPercent: 'Most of a topic one setter can write, in percent',
  bankMultiple: 'Question bank size, as a multiple of the questions used',
  questionsClose: 'Questions close',
  rpcHost: 'Public record provider',
  inviteRole: 'Role',
  inviteName: /Name for the approved list|Your own note/,
  option: (letter: string) => `Option ${letter}`,
  examId: 'Exam ID',
};

export const button = {
  continue: 'Continue',
  addTopic: 'Add topic',
  publish: 'Publish the exam',
  bringPeople: 'Bring people in',
  addInvite: 'Add invite',
  copyLink: /^Copy link$|^Copied$/,
  reissue: /Reissue/,
  postList: 'Post the list',
  postBuild: 'Post to the public record',
  useVersion: /^Use v\d/,
  register: /Register your security key/,
  seal: /Seal this question|Send this question again/,
  release: /Release my share/,
  unlock: /Open the paper|Unlock the paper/,
  addOption: 'Add an option',
  removeOption: (letter: string) => `Remove option ${letter}`,
  openExam: 'Open this exam',
  checkAgain: 'Check again',
  tryAgain: 'Try again',
};

export const radio = {
  written: 'Written',
  multipleChoice: 'Multiple choice',
};

export const fold = {
  advanced: 'Advanced',
  examRecord: 'Exam record',
  differentVersion: 'Use a different version',
};

/** Opens a folded section if it is closed. */
export async function unfold(page: Page, summary: string): Promise<void> {
  const summaryEl = page.locator('summary', { hasText: summary }).first();
  if ((await summaryEl.locator('xpath=..').getAttribute('open')) === null) await summaryEl.click();
}

/** A `Hash` carries its whole value in its title, behind a button named "Copy <label>: ...". */
export async function hashOf(page: Page, label: string): Promise<string> {
  return (await page.getByRole('button', { name: `Copy ${label}: ` }).first().getAttribute('title')) ?? '';
}

/** The verifier's chain of custody: one list item per step, with its state as a data attribute. */
export async function stepStates(page: Page): Promise<{ label: string; state: string }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('li[data-state]')).map((li) => ({
      label: (li.querySelector('[class$="step-label"]')?.textContent ?? '').trim(),
      state: li.getAttribute('data-state') ?? '',
    })),
  );
}

export const verifierText = {
  pickerError: 'Enter a 32-byte ID starting with 0x.',
  invalidLink: 'The link did not hold a valid exam ID.',
  openExam: 'Open this exam',
};

/** The setter's composer. */
export const composer = {
  question: 'Your question',
  topicRadio: (name: string) => new RegExp(name),
  sealedSoFar: (n: number) => new RegExp(`^${String(n)} questions? sealed so far`),
  /** The note beside an option that is blank or repeated. */
  optionError: '.ss-option-error',
  answerKeyNote: /answer key isn.t sent/,
};

export const centre = {
  openPaper: /^Open the paper$/,
  paperOpenHeading: 'The paper is open',
  printPaper: 'Print the paper',
};
