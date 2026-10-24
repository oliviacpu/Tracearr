import { describe, expect, it, vi } from 'vitest';

// Each select resolves to the next queued answer (an array of rows, or an Error to throw).
const answers: unknown[] = [];
const select = vi.fn(() => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    },
  };
  return chain;
});
vi.mock('../../../db/client.js', () => ({ db: { select: () => select() } }));

import { itemGenres } from '../itemGenres.js';

describe('itemGenres', () => {
  it("reads the server's own copy first", async () => {
    answers.push([{ genres: ['Comedy', 'Horror'] }]);
    await expect(itemGenres('server-1', '4242', 'media-1')).resolves.toEqual(['Comedy', 'Horror']);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('falls back to the media row when the copy has none', async () => {
    answers.push([{ genres: [] }], [{ genres: ['Western'] }]);
    await expect(itemGenres('server-1', '4242', 'media-1')).resolves.toEqual(['Western']);
  });

  it('has none without a record, and none when the read fails', async () => {
    answers.push([], [{ genres: null }]);
    await expect(itemGenres('server-1', '4242', 'media-1')).resolves.toEqual([]);
    await expect(itemGenres('server-1', null, null)).resolves.toEqual([]);

    answers.push(new Error('connection refused'));
    await expect(itemGenres('server-1', '4242', null)).resolves.toEqual([]);
  });
});
