import { describe, expect, it } from 'vitest';

import { sayOf, splitDetails, withDetails } from './details';

describe('details', () => {
  it('keeps the plain sentence apart from the technical reason', () => {
    const message = withDetails('Try again in a minute.', 'HTTP 503');
    expect(splitDetails(message)).toEqual({ say: 'Try again in a minute.', detail: 'HTTP 503' });
    expect(sayOf(message)).toBe('Try again in a minute.');
  });

  it('leaves a message with no reason alone', () => {
    expect(withDetails('Try again in a minute.', '')).toBe('Try again in a minute.');
    expect(splitDetails('Try again in a minute.')).toEqual({ say: 'Try again in a minute.', detail: null });
  });
});
