// @vitest-environment jsdom
import type { ExamRow, ParticipantRow } from '@paperseal/arkiv';
import type { ExamNameResult, ResolvedExamName } from '@paperseal/chain';
import { encodeApprovedList, toHex, type Hex } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { sha256, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { App } from './App';
import { approvedList, offlineQuicknet, registryAddress } from '@paperseal/verify/fixtures';
import type { HistoryReader, HistoryRegistry } from './history';
import { examLink, isHistoryRoute, routeOfHash } from './link';
import { SettingsProvider, type Settings } from './settings';

/*
 * The Arkiv reader, the registry and the name check are stubbed whole. Approved lists are real
 * encodings, decoded and checked by the page's own code.
 */

const writer: Address = '0x1111111111111111111111111111111111111111';
const idOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const criteriaOf = (n: number): Hex => `0x${n.toString(16).padStart(64, 'c')}`;
/** Exams 5 to 7 started long ago. */
const startOf = (n: number) => BigInt(n >= 5 ? 1_600_000_000 + n : 1_900_000_000 + n * 86_400);

let reader: { examRows: Mock<HistoryReader['examRows']>; participantRows: Mock<HistoryReader['participantRows']> } | null = null;
let readersMade = 0;
vi.mock('@paperseal/arkiv', async (original) => {
  const real = await original<typeof import('@paperseal/arkiv')>();
  return {
    ...real,
    createArkivReader: () => {
      readersMade += 1;
      return reader;
    },
  };
});

let registry: HistoryRegistry | null = null;
let nameAnswer: (name: string) => ExamNameResult = (name) => ({ ok: false, failed: 'forward', reason: name, partial: {} });
vi.mock('@paperseal/chain', async (original) => {
  const real = await original<typeof import('@paperseal/chain')>();
  return {
    ...real,
    createExamRegistry: (options: { address: Address }) => ({ ...registry, address: options.address }),
    resolveExamName: (name: string) => Promise.resolve(nameAnswer(name)),
  };
});

const entries = approvedList();
const centre = entries.find((entry) => entry.role === 3);
if (!centre) throw new Error('no centre in the fixture list');

const settings: Settings = {
  rpcUrl: 'https://rpc.example',
  teeUrl: '',
  storageUrl: '',
  registryAddress,
  examId: '',
  arkivRpcUrl: 'https://arkiv.example',
  arkivWriters: writer,
  swarmApiUrl: '',
};

function examRow(n: number, over: Partial<ExamRow> = {}): ExamRow {
  return {
    entityKey: idOf(1000 + n),
    creator: writer,
    createdAtBlock: 1n,
    examId: idOf(n),
    registry: registryAddress,
    board: writer,
    chainId: 11155111n,
    stage: 'published',
    examStart: startOf(n),
    createdBlock: 1n,
    criteriaHash: criteriaOf(n),
    approvedListHash: '',
    paperHash: '',
    name: '',
    ...over,
  };
}

function participantRow(n: number, over: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    entityKey: idOf(2000 + n),
    creator: writer,
    createdAtBlock: 1n,
    examId: idOf(n),
    registry: registryAddress,
    role: 'centre-holder',
    owner: centre?.owner ?? '',
    passkeyKeyHash: centre ? sha256(centre.passkeyPublicKey).toLowerCase() : '',
    derivedKeyHash: '',
    ...over,
  };
}

/** Exams 1 to 7 are on the registry. 1 and 6 are built, 2, 3 and 5 have their list, 4 and 7 only exist. 5 to 7 started long ago. */
function arrange(rows: { exams: ExamRow[]; participants?: ParticipantRow[] }) {
  const onChain = new Set([1, 2, 3, 4, 5, 6, 7].map(idOf));
  const hasList = (id: number) => id <= 3 || id === 5 || id === 6;
  const n = (examId: Hex) => Number(BigInt(examId));
  reader = {
    examRows: vi.fn<HistoryReader['examRows']>(() => Promise.resolve(rows.exams)),
    participantRows: vi.fn<HistoryReader['participantRows']>(() => Promise.resolve(rows.participants ?? [])),
  };
  registry = {
    address: registryAddress,
    getExam: vi.fn((examId: Hex) =>
      Promise.resolve(onChain.has(examId) ? { createdAt: 1n, createdBlock: 1n, settings: { examStart: startOf(n(examId)), criteriaHash: criteriaOf(n(examId)) } } : null),
    ),
    getApprovedList: vi.fn((examId: Hex) => Promise.resolve(onChain.has(examId) && hasList(n(examId)) ? { listHash: '0x', postedAt: 1n, postedBlock: 1n } : null)),
    getBuild: vi.fn((examId: Hex) => Promise.resolve(n(examId) === 1 || n(examId) === 6 ? { paperHash: '0x', postedAt: 1n } : null)),
    // Exam 3's list does not hold the centre.
    getApprovedListEntries: vi.fn((examId: Hex) =>
      Promise.resolve(
        onChain.has(examId) && hasList(n(examId))
          ? toHex(encodeApprovedList(n(examId) === 3 ? entries.map((entry) => (entry === centre ? { ...entry, owner: 'Someone else' } : entry)) : entries))
          : null,
      ),
    ),
  } as unknown as HistoryRegistry;
}

function open(over: Partial<Settings> = {}, path = '/exams') {
  return render(
    <SettingsProvider initial={{ ...settings, ...over }} drand={offlineQuicknet(1000)}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </SettingsProvider>,
  );
}

const panel = (title: string) => {
  const heading = screen.getByRole('heading', { name: title });
  return heading.parentElement as HTMLElement;
};

beforeEach(() => {
  reader = null;
  registry = null;
  readersMade = 0;
  nameAnswer = (name) => ({ ok: false, failed: 'forward', reason: name, partial: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the exam history route', () => {
  it('is #/exams, which names no exam', () => {
    expect(isHistoryRoute('/exams')).toBe(true);
    expect(isHistoryRoute('/exams/')).toBe(true);
    expect(isHistoryRoute('/exam/0x11')).toBe(false);
    expect(isHistoryRoute('/')).toBe(false);
    expect(routeOfHash('#/exams')).toEqual({ routePath: '/exams', routeSearch: '' });
    expect(examLink({ search: '', routePath: '/exams', routeSearch: '' })).toEqual({ kind: 'none' });
  });

  it('opens the history page, and the main page links to it', () => {
    arrange({ exams: [] });
    open();
    expect(screen.getByRole('heading', { name: 'Exam history', level: 1 })).toBeTruthy();
    cleanup();
    open({}, '/');
    expect(screen.getByRole('link', { name: 'See the exam history' }).getAttribute('href')).toBe('/exams');
  });
});

describe('the exam history', () => {
  it('lists verified exams newest first, at the stage the public record shows', async () => {
    arrange({ exams: [examRow(2, { stage: 'listed' }), examRow(1, { stage: 'listed' }), examRow(3, { stage: 'listed' })] });
    open();
    const list = await within(panel('Exams on this record')).findAllByRole('link');
    expect(list.map((link) => link.getAttribute('href'))).toEqual([`/exam/${idOf(3)}`, `/exam/${idOf(2)}`, `/exam/${idOf(1)}`]);
    expect(reader?.examRows).toHaveBeenCalledWith(registryAddress, [writer]);
    const built = list[2]?.closest('li') as HTMLElement;
    expect(within(built).getByText('Sealed')).toBeTruthy();
    expect(within(built).getByText('The Arkiv copy is behind.')).toBeTruthy();
    const listed = list[0]?.closest('li') as HTMLElement;
    expect(within(listed).getByText(/Taking questions|Waiting for the paper/)).toBeTruthy();
    expect(within(listed).queryByText('The Arkiv copy is behind.')).toBeNull();
    expect(screen.getByText('This list shows the exams these writers have indexed. An exam missing here may still exist.')).toBeTruthy();
  });

  it('ignores and counts rows not on the public record, or that differ from it', async () => {
    arrange({ exams: [examRow(4), examRow(9), examRow(2, { examStart: 5n }), examRow(3, { criteriaHash: criteriaOf(8) })] });
    open();
    const links = await within(panel('Exams on this record')).findAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([`/exam/${idOf(4)}`]);
    expect(screen.getByText('3 rows were ignored because the public record does not match')).toBeTruthy();
    expect(screen.getByText('1 row names an exam not on the public record.')).toBeTruthy();
    expect(screen.getByText('2 rows have a different start time or criteria from the public record.')).toBeTruthy();
  });

  it('shows a name only after it passes again, and the ID when it fails', async () => {
    arrange({ exams: [examRow(1, { name: 'good.board.eth' }), examRow(2, { name: 'bad.board.eth' })] });
    nameAnswer = (name) =>
      name === 'good.board.eth'
        ? { ok: true, value: { name, examId: idOf(1), registry: registryAddress } as ResolvedExamName }
        : { ok: false, failed: 'primaryName', reason: 'differs', partial: {} };
    open();
    const named = await screen.findByRole('link', { name: 'good.board.eth' });
    expect(named.getAttribute('href')).toBe('/name/good.board.eth');
    expect(screen.getByRole('link', { name: `Exam ${idOf(2)}` }).getAttribute('href')).toBe(`/exam/${idOf(2)}`);
    expect(screen.queryByText('bad.board.eth')).toBeNull();
    expect(screen.getByText(/1 name did not pass the name check/)).toBeTruthy();
  });

  it('reads again when asked', async () => {
    arrange({ exams: [examRow(1)] });
    open();
    await screen.findByRole('link', { name: `Exam ${idOf(1)}` });
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    await screen.findByRole('link', { name: `Exam ${idOf(1)}` });
    expect(reader?.examRows).toHaveBeenCalledTimes(2);
  });

  it('shows an exam whose reads fail as not read yet, while the others render, and reads it again when asked', async () => {
    arrange({ exams: [examRow(1), examRow(2), examRow(9)] });
    const getBuild = registry?.getBuild as HistoryRegistry['getBuild'];
    let limited = true;
    if (registry) {
      registry.getBuild = vi.fn((examId: Hex) =>
        limited && examId === idOf(2) ? Promise.reject(new Error('HTTP request failed. Status: 429')) : getBuild(examId),
      );
    }
    open();
    const rows = within(panel('Exams on this record'));
    const unread = (await rows.findByRole('link', { name: `Exam ${idOf(2)}` })).closest('li') as HTMLElement;
    expect(within(unread).getByText('Could not be read yet.')).toBeTruthy();
    expect(within(unread).getByText('Not checked')).toBeTruthy();
    expect(within(unread).getByText('HTTP request failed. Status: 429')).toBeTruthy();
    expect(within(unread).queryByText(/Starts|Exam published|People approved|Paper built/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[data-status="fail"]')).toBeNull();
    const built = rows.getByRole('link', { name: `Exam ${idOf(1)}` }).closest('li') as HTMLElement;
    expect(within(built).getByText('Sealed')).toBeTruthy();
    expect(screen.getByText(/1 exam could not be read from the public record yet/)).toBeTruthy();
    // Exam 9 is not on the record: ignored and counted on its own, not as unread.
    expect(screen.getByText('1 row was ignored because the public record does not match')).toBeTruthy();

    limited = false;
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    const read = (await screen.findByText(/Taking questions|Waiting for the paper/, { selector: '.ps-badge' })).closest('li') as HTMLElement;
    expect(within(read).getByRole('link', { name: `Exam ${idOf(2)}` })).toBeTruthy();
    expect(screen.queryByText('Could not be read yet.')).toBeNull();
  });

  it('leaves out exams that never ran, with no fold or count, and keeps built and upcoming ones', async () => {
    arrange({ exams: [examRow(1), examRow(4), examRow(5), examRow(6), examRow(7)] });
    open();
    const links = await within(panel('Exams on this record')).findAllByRole('link');
    const hrefs = links.map((link) => link.getAttribute('href'));
    expect(hrefs).toContain(`/exam/${idOf(6)}`);
    expect(hrefs).toContain(`/exam/${idOf(4)}`);
    expect(hrefs).toContain(`/exam/${idOf(1)}`);
    expect(hrefs).not.toContain(`/exam/${idOf(5)}`);
    expect(hrefs).not.toContain(`/exam/${idOf(7)}`);
    expect(screen.queryByText(/never ran/i)).toBeNull();
    expect(screen.queryByText(/No paper was built/)).toBeNull();
    expect(screen.queryByRole('option', { name: 'Never ran' })).toBeNull();
    expect(screen.queryByText(/ignored/)).toBeNull();
  });

  it('shows no empty-list hint when every exam never ran', async () => {
    arrange({ exams: [examRow(5), examRow(7)] });
    open();
    await screen.findByText(/have not indexed any exam/);
    expect(screen.queryByText(/never ran/i)).toBeNull();
  });

  it('still opens a hidden exam by a direct link', async () => {
    arrange({ exams: [examRow(5)] });
    open({}, `/exam/${idOf(5)}`);
    expect(await screen.findByRole('list', { name: 'Steps for this exam' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Exam history', level: 1 })).toBeNull();
  });

  it('says when it could not be read', async () => {
    arrange({ exams: [] });
    reader?.examRows.mockImplementation(() => Promise.reject(new Error('Arkiv is down')));
    open();
    // It stays on "Reading" while it tries again, and only then says so.
    expect(await screen.findByText(/Reading the exam history/)).toBeTruthy();
    expect(screen.queryByText(/The exam history could not be read/)).toBeNull();
    expect(await screen.findByText(/The exam history could not be read/, {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByText('Arkiv is down')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read again' })).toBeTruthy();
  }, 10_000);

  it('reads nothing without writers, and says how to add them', () => {
    arrange({ exams: [examRow(1)] });
    open({ arkivWriters: '' });
    expect(screen.getByText(/Add the Arkiv writer addresses your exam board publishes/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Exams on this record' })).toBeNull();
    expect(readersMade).toBe(0);
    expect(reader?.examRows).not.toHaveBeenCalled();
    expect(registry?.getExam).not.toHaveBeenCalled();
  });
});

describe('finding exams by person', () => {
  it("lists only exams whose list on the public record holds the entry, with the role in plain words", async () => {
    arrange({ exams: [], participants: [participantRow(1), participantRow(2, { role: 'centre' }), participantRow(3), participantRow(4)] });
    open();
    fireEvent.change(screen.getByLabelText(/Name on the list/), { target: { value: centre.owner } });
    fireEvent.click(screen.getByRole('button', { name: 'Find exams' }));
    const found = await within(panel('Find exams by person')).findAllByRole('link');
    expect(found.map((link) => link.getAttribute('href'))).toEqual([`/exam/${idOf(1)}`]);
    expect(within(found[0]?.closest('li') as HTMLElement).getByText('Centre holding part of the key')).toBeTruthy();
    expect(reader?.participantRows).toHaveBeenCalledWith({ registry: registryAddress, owner: centre.owner }, [writer]);
    expect(screen.getByText(/3 entries were not shown/)).toBeTruthy();
  });

  it('shows an exam whose list could not be read as not checked, while the others are checked', async () => {
    arrange({ exams: [], participants: [participantRow(1), participantRow(2)] });
    const getEntries = registry?.getApprovedListEntries as HistoryRegistry['getApprovedListEntries'];
    let limited = true;
    if (registry) {
      registry.getApprovedListEntries = vi.fn((examId: Hex) =>
        limited && examId === idOf(2) ? Promise.reject(new Error('HTTP request failed. Status: 429')) : getEntries(examId),
      );
    }
    open();
    fireEvent.change(screen.getByLabelText(/Name on the list/), { target: { value: centre.owner } });
    fireEvent.click(screen.getByRole('button', { name: 'Find exams' }));
    const results = within(panel('Find exams by person'));
    const unchecked = (await results.findByRole('link', { name: `Exam ${idOf(2)}` })).closest('li') as HTMLElement;
    expect(within(unchecked).getByText('Not checked')).toBeTruthy();
    expect(within(unchecked).getByText('The list of people for this exam could not be read yet.')).toBeTruthy();
    expect(within(unchecked).getByText('HTTP request failed. Status: 429')).toBeTruthy();
    expect(within(unchecked).queryByText('Centre holding part of the key')).toBeNull();
    const checked = results.getByRole('link', { name: `Exam ${idOf(1)}` }).closest('li') as HTMLElement;
    expect(within(checked).getByText('Centre holding part of the key')).toBeTruthy();
    expect(screen.getByText(/1 exam could not be checked yet/)).toBeTruthy();
    expect(screen.queryByText(/not shown/)).toBeNull();

    // Searching again reads again.
    limited = false;
    fireEvent.click(screen.getByRole('button', { name: 'Find exams' }));
    await waitFor(() => {
      expect(results.getAllByText('Centre holding part of the key')).toHaveLength(2);
    });
  });

  it('leaves out abandoned exams from a search, keeps a built one, and keeps one whose Build could not be read', async () => {
    arrange({ exams: [], participants: [participantRow(1), participantRow(5), participantRow(6), participantRow(2)] });
    const getBuild = registry?.getBuild as HistoryRegistry['getBuild'];
    if (registry) {
      registry.getBuild = vi.fn((examId: Hex) => (examId === idOf(2) ? Promise.reject(new Error('429')) : getBuild(examId)));
    }
    open();
    fireEvent.change(screen.getByLabelText(/Name on the list/), { target: { value: centre.owner } });
    fireEvent.click(screen.getByRole('button', { name: 'Find exams' }));
    const found = await within(panel('Find exams by person')).findAllByRole('link');
    const hrefs = found.map((link) => link.getAttribute('href'));
    expect(hrefs).toContain(`/exam/${idOf(6)}`);
    expect(hrefs).toContain(`/exam/${idOf(1)}`);
    expect(hrefs).toContain(`/exam/${idOf(2)}`);
    expect(hrefs).not.toContain(`/exam/${idOf(5)}`);
    expect(screen.queryByText(/never ran/i)).toBeNull();
  });

  it('asks for a name before searching', () => {
    arrange({ exams: [] });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Find exams' }));
    expect(screen.getByText(/Enter a name exactly as it appears/)).toBeTruthy();
    expect(reader?.participantRows).not.toHaveBeenCalled();
  });
});
