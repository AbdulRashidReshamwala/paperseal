import { fromHex, roles, setterCommitment, type ApprovedListEntry } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { approvedList, examId, setterName, setterSalt } from './fixtures';
import { checkPublishedSetters, parsePublishedSetters, SetterJsonError, setterCommitments } from './setters';

const entries = (): ApprovedListEntry[] => approvedList();

describe('setter names', () => {
  it('the fixture list holds a commitment, never the name', () => {
    const [owner] = setterCommitments(entries());
    expect(owner).toBe(setterCommitment(fromHex(examId), setterName, fromHex(setterSalt)));
    expect(owner).not.toContain(setterName);
  });

  it('passes a name and salt that recompute to the on-chain commitment', () => {
    const report = checkPublishedSetters(examId, entries(), [{ name: setterName, salt: setterSalt }]);
    expect(report.rows.map((row) => row.check)).toEqual(['pass']);
    expect(report.coverage).toBe('pass');
  });

  it('fails a wrong name, a wrong salt and a swapped exam', () => {
    const wrong = checkPublishedSetters(examId, entries(), [
      { name: 'Someone Else', salt: setterSalt },
      { name: setterName, salt: `0x${'00'.repeat(32)}` },
    ]);
    expect(wrong.rows.map((row) => row.check)).toEqual(['fail', 'fail']);
    expect(wrong.coverage).toBe('fail');
    expect(wrong.unmatched).toHaveLength(1);
    const otherExam = checkPublishedSetters(`0x${'22'.repeat(32)}`, entries(), [{ name: setterName, salt: setterSalt }]);
    expect(otherExam.rows[0]?.check).toBe('fail');
  });

  it('reports an on-chain setter nobody published as still sealed', () => {
    const list = entries();
    const extra = { ...(list[0] as ApprovedListEntry), owner: `0x${'ab'.repeat(32)}`, passkeyPublicKey: Uint8Array.from([4, ...new Uint8Array(64).fill(9)]) };
    const report = checkPublishedSetters(examId, [...list, extra], [{ name: setterName, salt: setterSalt }]);
    expect(report.rows[0]?.check).toBe('pass');
    expect(report.unmatched).toEqual([extra.owner]);
    expect(report.coverage).toBe('fail');
    expect(list.filter((e) => e.role === roles.setter)).toHaveLength(1);
  });

  it('parses the published JSON and rejects malformed input in words', () => {
    expect(parsePublishedSetters(JSON.stringify([{ name: 'A', salt: setterSalt }]))).toEqual([{ name: 'A', salt: setterSalt }]);
    for (const bad of ['nope', '{}', '[]', '[1]', '[{"name":"","salt":"0x"}]', `[{"name":"A","salt":"${setterSalt.toUpperCase()}"}]`, '[{"name":"A"}]']) {
      expect(() => parsePublishedSetters(bad), bad).toThrow(SetterJsonError);
    }
  });
});
