import { describe, expect, it, vi } from 'vitest';
import { HttpRequestError } from 'viem';

import { politeReads, READ_TRIES, READS_AT_ONCE, sourceBusy } from './rpc';

const limited = () => new HttpRequestError({ url: 'https://rpc.example', status: 429, details: 'Too Many Requests' });
const call = (data: string, block = 'latest') => ({ method: 'eth_call', params: [{ data }, block] });
const logs = (from: string, to = from) => ({ method: 'eth_getLogs', params: [{ fromBlock: from, toBlock: to }] });
const noWait = () => Promise.resolve();

describe('sourceBusy', () => {
  it('knows a limited source from any other failure', () => {
    expect(sourceBusy('Request exceeds defined limit.')).toBe(true);
    expect(sourceBusy(limited().message)).toBe(true);
    expect(sourceBusy('The RPC failed before the name could be checked: HTTP request failed. Status: 429')).toBe(true);
    expect(sourceBusy('Failed to fetch')).toBe(false);
    expect(sourceBusy('execution reverted')).toBe(false);
  });
});

describe('politeReads', () => {
  it('sends a failed read again within the load, single-block logs included', async () => {
    const send = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(limited()).mockResolvedValue([{ data: '0x' }]);
    await expect(politeReads(send, noWait)(logs('0x10'))).resolves.toEqual([{ data: '0x' }]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('passes a failure on after its tries, unchanged', async () => {
    const error = limited();
    const send = vi.fn(() => Promise.reject(error));
    await expect(politeReads(send, noWait)(call('0x1'))).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(READ_TRIES);
  });

  it('does not send a revert again: it is an answer', async () => {
    const send = vi.fn(() => Promise.reject(new Error('execution reverted')));
    await expect(politeReads(send, noWait)(call('0x1'))).rejects.toThrow('reverted');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('waits longer each time the source is busy, and starts over once it answers', async () => {
    const pauses: number[] = [];
    const send = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(limited()).mockRejectedValueOnce(limited()).mockResolvedValueOnce('a').mockRejectedValueOnce(limited()).mockResolvedValue('b');
    const read = politeReads(send, (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    });
    await read(call('0x1'));
    await read(call('0x2'));
    expect(pauses).toEqual([1000, 2000, 1000]);
  });

  it('holds every read while the source is busy', async () => {
    let resume: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const send = vi.fn<(read: { method: string }) => Promise<unknown>>().mockRejectedValueOnce(limited()).mockResolvedValue('ok');
    const read = politeReads(send, () => hold);
    const first = read(call('0x1'));
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    const second = read(call('0x2'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(1);
    resume();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('sends identical reads under way once', async () => {
    const send = vi.fn(() => Promise.resolve('0x1'));
    const read = politeReads(send, noWait);
    await Promise.all([read(call('0x1')), read(call('0x1'))]);
    expect(send).toHaveBeenCalledTimes(1);
    await read(call('0x1'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps only answers that cannot change', async () => {
    const send = vi.fn(({ method }: { method: string }) => Promise.resolve(method === 'eth_getLogs' ? [{ data: '0x' }] : '0x1'));
    const read = politeReads(send, noWait);
    await read(call('0x1', '0x64'));
    await read(call('0x1', '0x64'));
    await read(logs('0x64'));
    await read(logs('0x64'));
    expect(send).toHaveBeenCalledTimes(2);
    await read(logs('0x64', '0x65'));
    await read(logs('0x64', '0x65'));
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('does not keep an empty log read', async () => {
    const send = vi.fn(() => Promise.resolve([]));
    const read = politeReads(send, noWait);
    await read(logs('0x64'));
    await read(logs('0x64'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends only a few reads at once', async () => {
    let now = 0;
    let most = 0;
    const send = vi.fn(async () => {
      now += 1;
      most = Math.max(most, now);
      await new Promise((resolve) => setTimeout(resolve, 0));
      now -= 1;
      return '0x1';
    });
    const read = politeReads(send, noWait);
    await Promise.all(Array.from({ length: 12 }, (_, at) => read(call(`0x${String(at)}`))));
    expect(send).toHaveBeenCalledTimes(12);
    expect(most).toBe(READS_AT_ONCE);
  });
});
