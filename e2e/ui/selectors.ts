import type { Page } from 'playwright-core';

/*
 * The one place that knows the app's words, so every exact string the suite relies on is here, and
 * tests use these names. Prefer
 * roles (button, heading, radio, textbox) with a name from this file over text matches in a test.
 *
 * Exact-text selectors that cannot be avoided are the ones whose label IS the control's name:
 * field labels, button names and the headings that name a screen. They are all below.
 */

export const text = {
  // Board
  createHeading: 'Create the exam',
  reviewHeading: 'Preview and submit',
  peopleHeading: 'Bring everyone in',
  /** The stamp above the invites once the read-back matched. */
  publishedStamp: 'Published',
  recordBuildHeading: 'The paper is ready',
  wrongAccount: /not the exam board.s account/i,
  // Shared
  keyRegisteredHeading: /You.re registered/,
  keyCardHeading: 'Your key card',
  alreadySetUpHeading: 'This security key is already set up',
  linkProblemHeading: /This invitation link doesn.t work/,
  openLinkHeading: 'Open your invitation link',
  endedHeading: 'This exam has ended',
  nothingToDoYet: 'Nothing to do yet',
  cantConnect: /Can.t connect right now/,
  paperSealStopped: 'Paper Seal has stopped',
  waitingForPaperSeal: 'Waiting for Paper Seal',
  // Setter
  writeHeading: 'Write a question',
  composerBlockedHeading: /We can.t take your questions yet/,
  // Release
  releaseHeading: 'Release your part of the key',
  releaseFailedHeading: 'Your part of the key was not sent',
  keyHolderDone: /Done\. You can close this tab/,
};

export const field = {
  examName: 'Exam name',
  examStart: 'Date and time of the exam',
  length: 'Length, in minutes',
  releaseMinutes: 'Minutes before the exam to release the paper to centres',
  topicName: (n: number) => `Topic ${String(n)} name`,
  topicQuestions: (n: number) => `Topic ${String(n)} questions`,
  maxPercent: 'Most of a topic one setter can write, in percent',
  bankMultiple: 'How many questions to collect, compared with the questions used',
  questionsClose: 'Questions close',
  rpcHost: 'Public record address',
  inviteNote: /^A note for yourself/,
  partyName: /^Your name/,
  option: (letter: string) => `Option ${letter}`,
  examId: 'Exam ID',
  /** The select inside "Use a different version". */
  version: 'Version',
};

export const button = {
  connectWallet: 'Connect your wallet',
  continue: 'Continue',
  addTopic: 'Add topic',
  publish: 'Publish the exam',
  addInvite: 'Add invite',
  copyExamLink: 'Copy the exam link',
  copyLink: /^Copy link$|^Copied$/,
  reissue: /Make a new link/,
  postList: 'Post the list',
  postBuild: 'Post the paper’s record',
  register: /Register your security key/,
  enrol: 'Set up your security key',
  registerByName: 'Register with your security key',
  seal: /Seal this question|Send this question again/,
  release: /Release my part of the key/,
  unlock: /Open the paper/,
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

/** The centres page, then the neutral parties page, typing each name so no directory is needed. */
export async function choosePeople(page: Page, centres: readonly string[], neutrals: readonly string[]): Promise<void> {
  const add = async (name: string) => {
    await page.getByLabel("Add a name that isn't listed").fill(name);
    await page.getByRole('button', { name: 'Add name' }).click();
  };
  for (const name of centres) await add(name);
  await page.getByRole('button', { name: button.continue }).click();
  for (const name of neutrals) await add(name);
  await page.getByRole('button', { name: button.continue }).click();
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
  pickerError: 'Enter an exam ID: 0x followed by 64 letters or digits.',
  invalidLink: 'This link does not hold a valid exam ID.',
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
  handOut: 'Hand out the paper',
  handOutHeading: 'Hand out the paper',
  sendToRooms: 'Send to the rooms',
  addRoom: 'Add a room',
  demoLabel: 'Demo: nothing is sent to any room',
  copiesFor: (room: string) => `Copies for ${room}`,
  sentInDemo: 'Marked as sent (demo)',
  printPaper: 'Print the paper',
};
