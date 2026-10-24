import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));

import {
  airingMatches,
  createLiveTvGuide,
  type GuideQuery,
  type GuideSource,
  type LiveTvProgrammeRef,
} from '../liveTvGuide.js';
import type { PlexGuideAiring } from '../mediaServer/plex/guide.js';

const GUIDE = 'tv.plex.providers.epg.xmltv:4';
const T0 = Date.UTC(2026, 9, 24, 20, 0, 0); // a programme boundary
const MIN = 60_000;

function airing(over: Partial<PlexGuideAiring> & { channelId?: string }): PlexGuideAiring {
  const { channelId = '4', ...rest } = over;
  return {
    type: 'episode',
    title: 'Best Men',
    showTitle: 'Modern Family',
    seasonNumber: 4,
    episodeNumber: 17,
    year: null,
    beginsAt: T0,
    endsAt: T0 + 30 * MIN,
    channel: {
      id: channelId,
      number: '5',
      title: '5 Sitcoms',
      callSign: 'Sitcoms',
      thumb: 'https://guide.example.com/images/sitcoms.png',
    },
    ...rest,
  };
}

const modernFamily = airing({});
const abbott = airing({
  title: 'Pilot',
  showTitle: 'Abbott Elementary',
  seasonNumber: 1,
  episodeNumber: 1,
  beginsAt: T0 + 30 * MIN,
  endsAt: T0 + 60 * MIN,
});
const later = airing({
  title: 'Later',
  showTitle: 'Other Show',
  beginsAt: T0 + 60 * MIN,
  endsAt: T0 + 90 * MIN,
});

const session: LiveTvProgrammeRef = {
  serverId: 'server-1',
  mediaTitle: 'Best Men',
  grandparentTitle: 'Modern Family',
  seasonNumber: 4,
  episodeNumber: 17,
};

function fakeSource(grid: PlexGuideAiring[], nextOnChannel: PlexGuideAiring[] = []) {
  const airings = vi.fn(async (_id: string, q: GuideQuery) =>
    q.startingBetween ? nextOnChannel : grid
  );
  const guideIds = vi.fn(async () => [GUIDE]);
  const source: GuideSource = { guideIds, airings };
  return { source, airings, guideIds };
}

let clock = T0 + 10 * MIN;
const now = () => clock;

beforeEach(() => {
  clock = T0 + 10 * MIN;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('airingMatches', () => {
  it('matches an episode by show, season and episode, in any case', () => {
    expect(airingMatches(modernFamily, { ...session, grandparentTitle: 'modern family ' })).toBe(
      true
    );
    expect(airingMatches(modernFamily, { ...session, episodeNumber: 18 })).toBe(false);
    expect(airingMatches(abbott, session)).toBe(false);
  });

  it('falls back to the episode title when either side has no numbers', () => {
    expect(
      airingMatches(modernFamily, { ...session, seasonNumber: null, episodeNumber: null })
    ).toBe(true);
    expect(
      airingMatches(airing({ seasonNumber: null }), { ...session, mediaTitle: 'Other title' })
    ).toBe(false);
  });

  it('matches a film by its title only', () => {
    const film = airing({ type: 'movie', title: 'Little Big Man', showTitle: null });
    const filmSession = {
      ...session,
      mediaTitle: 'Little Big Man',
      grandparentTitle: null,
      seasonNumber: null,
      episodeNumber: null,
    };
    expect(airingMatches(film, filmSession)).toBe(true);
    expect(airingMatches(modernFamily, filmSession)).toBe(false);
  });
});

describe('liveTvGuide.findAiring', () => {
  it('names the channel airing the programme and what is on next', async () => {
    const { source, airings } = fakeSource([abbott, modernFamily], [later, abbott]);
    const guide = createLiveTvGuide({ sourceFor: async () => source, now });

    const found = await guide.findAiring(session, new Date(T0 + 10 * MIN), { next: true });

    expect(found?.channel).toEqual(modernFamily.channel);
    expect(found?.endsAt).toBe(T0 + 30 * MIN);
    expect(found?.next?.showTitle).toBe('Abbott Elementary');
    // The grid is asked for the minute the session played, then the channel's later slots.
    expect(airings).toHaveBeenNthCalledWith(1, GUIDE, {
      from: T0 + 10 * MIN,
      to: T0 + 11 * MIN,
    });
    expect(airings).toHaveBeenNthCalledWith(2, GUIDE, {
      from: T0 + 30 * MIN,
      to: T0 + 30 * MIN + 6 * 60 * MIN,
      channelId: '4',
      startingBetween: true,
    });
  });

  it('only looks up the next programme when asked', async () => {
    const { source, airings } = fakeSource([modernFamily], [abbott]);
    const guide = createLiveTvGuide({ sourceFor: async () => source, now });

    const found = await guide.findAiring(session, new Date(T0 + 10 * MIN));

    expect(found?.next).toBeNull();
    expect(airings).toHaveBeenCalledTimes(1);
  });

  it('shares one grid and one list of guides per server and minute', async () => {
    const { source, airings, guideIds } = fakeSource([modernFamily], [abbott]);
    const sourceFor = vi.fn(async () => source);
    const guide = createLiveTvGuide({ sourceFor, now });

    await Promise.all([
      guide.findAiring(session, new Date(T0 + 10 * MIN), { next: true }),
      guide.findAiring(session, new Date(T0 + 10 * MIN + 30_000), { next: true }),
    ]);
    await guide.findAiring(session, new Date(T0 + 10 * MIN + 59_000), { next: true });

    expect(sourceFor).toHaveBeenCalledTimes(1);
    expect(guideIds).toHaveBeenCalledTimes(1);
    expect(airings).toHaveBeenCalledTimes(2); // the grid once, the channel's next once

    await guide.findAiring(session, new Date(T0 + 12 * MIN));
    expect(airings).toHaveBeenCalledTimes(3); // another minute, another grid
  });

  it('asks again once the cached grid is stale', async () => {
    const { source, airings } = fakeSource([modernFamily]);
    const guide = createLiveTvGuide({ sourceFor: async () => source, now });

    await guide.findAiring(session, new Date(T0 + 10 * MIN));
    clock += 11 * MIN;
    await guide.findAiring(session, new Date(T0 + 10 * MIN));

    expect(airings).toHaveBeenCalledTimes(2);
  });

  it('gives null when no channel is airing the programme', async () => {
    const { source } = fakeSource([abbott, later]);
    const guide = createLiveTvGuide({ sourceFor: async () => source, now });

    await expect(guide.findAiring(session, new Date(T0 + 10 * MIN))).resolves.toBeNull();
  });

  it('gives null when the programme is on two channels at that moment', async () => {
    const { source } = fakeSource([modernFamily, airing({ channelId: '9' })]);
    const guide = createLiveTvGuide({ sourceFor: async () => source, now });

    await expect(guide.findAiring(session, new Date(T0 + 10 * MIN))).resolves.toBeNull();
  });

  it('prefers the airing on the air at that moment over a repeat in the same window', async () => {
    const repeat = airing({ channelId: '9', beginsAt: T0 + 10 * MIN + 30_000 });
    const early = airing({ endsAt: T0 + 10 * MIN + 30_000 });
    const { source } = fakeSource([early, repeat]);
    const guide = createLiveTvGuide({ sourceFor: async () => source, now });

    const found = await guide.findAiring(session, new Date(T0 + 10 * MIN));
    expect(found?.channel.id).toBe('4');
  });

  it('gives null for a server without a guide Tracearr can read', async () => {
    const guide = createLiveTvGuide({ sourceFor: async () => null, now });
    await expect(guide.findAiring(session, new Date(T0))).resolves.toBeNull();

    const { source } = fakeSource([modernFamily]);
    source.guideIds = async () => [];
    const noDvr = createLiveTvGuide({ sourceFor: async () => source, now });
    await expect(noDvr.findAiring(session, new Date(T0))).resolves.toBeNull();
  });

  it('gives null and warns once when the server fails, and asks again next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { source, airings } = fakeSource([modernFamily]);
    airings.mockRejectedValueOnce(new Error('Plex request failed: 500'));
    airings.mockRejectedValueOnce(new Error('Plex request failed: 500'));
    const guide = createLiveTvGuide({ sourceFor: async () => source, now });

    await expect(guide.findAiring(session, new Date(T0 + 10 * MIN))).resolves.toBeNull();
    await expect(guide.findAiring(session, new Date(T0 + 10 * MIN))).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('server-1');

    const found = await guide.findAiring(session, new Date(T0 + 10 * MIN));
    expect(found?.channel.id).toBe('4');
  });

  it('keeps the channel when only the next programme fails', async () => {
    const { source, airings } = fakeSource([modernFamily], [abbott]);
    airings.mockImplementation(async (_id, q) => {
      if (q.startingBetween) throw new Error('timeout');
      return [modernFamily];
    });
    const guide = createLiveTvGuide({ sourceFor: async () => source, now });

    const found = await guide.findAiring(session, new Date(T0 + 10 * MIN), { next: true });
    expect(found?.channel.id).toBe('4');
    expect(found?.next).toBeNull();
  });

  it('gives up with null when the server takes longer than the timeout', async () => {
    vi.useFakeTimers();
    const { source, airings } = fakeSource([modernFamily]);
    airings.mockImplementation(() => new Promise(() => undefined));
    const guide = createLiveTvGuide({ sourceFor: async () => source, now, timeoutMs: 2000 });

    const pending = guide.findAiring(session, new Date(T0 + 10 * MIN));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBeNull();
  });
});
