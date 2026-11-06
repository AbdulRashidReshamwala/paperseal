import { describe, expect, it } from 'vitest';

import type { CustodyStep, StepId } from './custody';
import type { Copies, Copy, Moment } from './facts';
import { evidenceTable, momentNotes, renumbered, shownFailures, shownNumbers, shownOrder } from './record';

const step = (id: StepId, number: number, state: CustodyStep['state'], at: number | null): CustodyStep => ({
  id,
  number,
  label: id,
  state,
  at,
  round: null,
  note: '',
  items: [],
  failures: [],
});

describe('the order of the steps', () => {
  it('lists finished steps by when they happened, then the rest as the protocol runs them, numbered as shown', () => {
    const steps = [
      step('published', 1, 'done', 100),
      step('attested', 2, 'done', 400),
      step('people', 3, 'done', 200),
      step('locked', 4, 'current', 300),
      step('sealed', 5, 'waiting', 500),
      step('unlock', 6, 'waiting', 600),
      step('open', 7, 'waiting', 700),
    ];
    const shown = shownOrder(steps);
    expect(shown.map((s) => [s.id, s.number])).toEqual([
      ['published', 1],
      ['people', 2],
      ['attested', 3],
      ['locked', 4],
      ['sealed', 5],
      ['unlock', 6],
      ['open', 7],
    ]);
    // The protocol's own numbers are left alone.
    expect(steps.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps a failed step with the steps still to come, in protocol order', () => {
    const shown = shownOrder([step('published', 1, 'done', 100), step('attested', 2, 'failed', 50), step('people', 3, 'done', 90), step('locked', 4, 'waiting', 10)]);
    expect(shown.map((s) => s.id)).toEqual(['people', 'published', 'attested', 'locked']);
  });

  it('keeps steps that happened together in protocol order', () => {
    const shown = shownOrder([step('attested', 2, 'done', 300), step('locked', 4, 'done', 300), step('people', 3, 'done', 300)]);
    expect(shown.map((s) => s.id)).toEqual(['attested', 'locked', 'people']);
  });

  it('keeps a finished step with no time just after the finished step before it', () => {
    const named = shownOrder([step('name', 1, 'done', null), step('published', 2, 'done', 500), step('attested', 3, 'done', null), step('people', 4, 'done', 100)]);
    expect(named.map((s) => s.id)).toEqual(['name', 'people', 'published', 'attested']);
  });

  it('points every number in a failure at the step as shown', () => {
    const steps = [step('published', 1, 'done', 100), step('attested', 2, 'failed', null), step('people', 3, 'done', 50), step('sealed', 5, 'failed', null)];
    const numbers = shownNumbers(steps, shownOrder(steps));
    expect(shownFailures([{ step: 2, label: 'attested', message: 'Not signed by the same machine. See step 5.' }], numbers)).toEqual([
      { step: 3, label: 'attested', message: 'Not signed by the same machine. See step 4.' },
    ]);
    expect(renumbered('Step 3 passed. Step 9 is not a step here.', numbers)).toBe('Step 1 passed. Step 9 is not a step here.');
  });
});

describe('moments folded into the steps', () => {
  it('adds each note to the step it belongs to, and leaves the exam start to its own fact', () => {
    const moments: Moment[] = [
      { id: 'built', label: 'Paper built and sealed', at: 1, round: 1n, happened: true, note: '3 seconds after questions closed.' },
      { id: 'unlock', label: 'Paper unlocked for centres', at: 2, round: 2n, happened: true, note: 'Enough key holders had released by this time.' },
      { id: 'start', label: 'Exam started', at: 3, round: null, happened: true, note: 'Not a step.' },
      { id: 'lock', label: 'Questions closed', at: 0, round: 0n, happened: true },
    ];
    expect([...momentNotes(moments)]).toEqual([
      ['sealed', '3 seconds after questions closed.'],
      ['unlock', 'Enough key holders had released by this time.'],
    ]);
  });
});

describe('the evidence table', () => {
  const copy = (source: Copy['source'], state: Copy['state'], used = false): Copy => ({ source, state, note: '', ...(used ? { used } : {}) });
  const found: Copies = {
    pieces: [
      { id: 'log', label: 'Record of releases', about: '', copies: [copy('bucket', 'checked', true), copy('arkiv', 'unread'), copy('swarm', 'missing'), copy('tee', 'held')] },
      { id: 'token', label: 'Proof of the machine', about: '', copies: [copy('bucket', 'failed'), copy('arkiv', 'reading'), copy('swarm', 'held')] },
      { id: 'paper', label: 'Paper files', about: '', copies: [copy('registry', 'checked'), copy('bucket', 'checked', true), copy('swarm', 'off')] },
      { id: 'keys', label: 'Keys', about: '', copies: [copy('bucket', 'missing'), copy('swarm', 'checked', true)] },
    ],
    feed: { state: 'off', text: '' },
  };
  const table = evidenceTable(found);

  it('has a column for each place that keeps a piece, and leaves the sealed machine to the details', () => {
    expect(table.sources.map((source) => source.label)).toEqual(['Exam record on Sepolia', 'Storage bucket', 'Arkiv', 'Swarm']);
    expect(table.rows.map((row) => row.label)).toEqual(['Record of releases', 'Proof of the machine', 'Paper files', 'Keys']);
  });

  it('says Checked only for a copy whose check passed', () => {
    const cells = table.rows.flatMap((row, r) => row.cells.map((cell, c) => ({ cell, copy: found.pieces[r]?.copies.find((held) => held.source === table.sources[c]?.id) })));
    for (const { cell, copy: held } of cells) {
      if (cell.kind === 'none') {
        expect(held).toBeUndefined();
        continue;
      }
      expect(cell.state).toBe(held?.state);
      expect(cell.word === 'Checked').toBe(held?.state === 'checked');
      expect(cell.tone === 'ok').toBe(held?.state === 'checked');
    }
  });

  it('sets failures apart, marks the copy this page used and shows a gap where a place keeps nothing', () => {
    const [log, token, paper, keys] = table.rows;
    expect(log?.cells).toEqual([
      { kind: 'none' },
      { kind: 'copy', state: 'checked', word: 'Checked', tone: 'ok', used: true },
      { kind: 'copy', state: 'unread', word: 'Could not be read', tone: 'bad', used: false },
      { kind: 'copy', state: 'missing', word: 'Not found', tone: 'neutral', used: false },
    ]);
    expect(token?.cells[1]).toEqual({ kind: 'copy', state: 'failed', word: 'Did not pass', tone: 'bad', used: false });
    expect(paper?.cells[2]).toEqual({ kind: 'none' });
    expect(keys?.cells[3]).toEqual({ kind: 'copy', state: 'checked', word: 'Checked', tone: 'ok', used: true });
  });

  it('drops a place no piece is kept in', () => {
    const bucketOnly = evidenceTable({ ...found, pieces: found.pieces.map((piece) => ({ ...piece, copies: piece.copies.filter((held) => held.source === 'bucket') })) });
    expect(bucketOnly.sources.map((source) => source.id)).toEqual(['bucket']);
  });
});
