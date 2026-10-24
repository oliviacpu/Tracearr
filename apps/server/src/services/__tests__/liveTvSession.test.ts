/**
 * liveTvSession (fork patch): what a Plex Live TV session leaves out, filled in from
 * the server's guide. The guide is a stub, so nothing here touches a server.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));

import type { ProcessedSession } from '../../jobs/poller/types.js';
import type { LiveTvAiring } from '../liveTvGuide.js';
import { channelFromGuide, createLiveTvSessions, lateChannelFields } from '../liveTvSession.js';

const T0 = Date.UTC(2026, 9, 24, 20, 10, 0);
const plex = { id: 'server-1', type: 'plex' };

// As Plex's /tv.plex.providers.epg.xmltv:4/grid lists Tunarr's channel 3.
const sitcoms = {
  id: '4',
  number: '3',
  title: '3 Sitcoms',
  callSign: 'Sitcoms',
  thumb: 'https://guide.example.com/images/uploads/sitcoms_icon.png?v=1',
};

const onAir: LiveTvAiring = { channel: sitcoms, beginsAt: T0, endsAt: T0 + 1_800_000, next: null };

function live(over: Partial<ProcessedSession> = {}): ProcessedSession {
  return {
    sessionKey: '12',
    ratingKey: '38389',
    mediaType: 'live',
    mediaTitle: 'Janet(s)',
    grandparentTitle: 'The Good Place',
    seasonNumber: 3,
    episodeNumber: 10,
    guid: 'tv.plex.xmltv://episode/The%20Good%20Place/3/10',
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    ...over,
  } as ProcessedSession;
}

let clock = T0;
const now = () => clock;

beforeEach(() => {
  clock = T0;
});

describe('channelFromGuide', () => {
  it('stores the name alone, the number viewers know and the logo', () => {
    expect(channelFromGuide(sitcoms)).toEqual({
      channelTitle: 'Sitcoms',
      channelIdentifier: '3',
      channelThumb: 'https://guide.example.com/images/uploads/sitcoms_icon.png?v=1',
    });
  });

  it('takes the name from the title without its number when there is no call sign', () => {
    expect(channelFromGuide({ ...sitcoms, callSign: null })?.channelTitle).toBe('Sitcoms');
    expect(
      channelFromGuide({ ...sitcoms, callSign: null, number: null, title: 'Sitcoms' })
    ).toEqual({ channelTitle: 'Sitcoms', channelIdentifier: null, channelThumb: sitcoms.thumb });
  });

  it('falls back to the number, and has nothing without a name or a number', () => {
    const bare = { id: '4', number: null, title: null, callSign: null, thumb: null };
    expect(channelFromGuide({ ...bare, number: '3' })?.channelTitle).toBe('3');
    expect(channelFromGuide(bare)).toBeNull();
  });
});

describe('lateChannelFields', () => {
  it('fills a recorded session that has no channel yet', () => {
    const found = { channelTitle: 'Sitcoms', channelIdentifier: '3', channelThumb: null };
    expect(lateChannelFields({ channelTitle: null }, found)).toEqual(found);
  });

  it('never replaces a stored channel, and has nothing to add without one', () => {
    const found = { channelTitle: 'Sitcoms', channelIdentifier: '3', channelThumb: null };
    expect(lateChannelFields({ channelTitle: 'ESPN' }, found)).toEqual({});
    expect(
      lateChannelFields(
        { channelTitle: null },
        { channelTitle: null, channelIdentifier: null, channelThumb: null }
      )
    ).toEqual({});
  });
});

describe('liveTvSessions.fill: the channel', () => {
  it("takes a Live TV session's channel from the guide, asked with its guid", async () => {
    const findAiring = vi.fn(async () => onAir);
    const tv = createLiveTvSessions({ guide: { findAiring }, now });
    const session = live();

    await tv.fill(plex, [session]);

    expect(session).toMatchObject({
      channelTitle: 'Sitcoms',
      channelIdentifier: '3',
      channelThumb: sitcoms.thumb,
    });
    expect(findAiring).toHaveBeenCalledWith(
      {
        serverId: 'server-1',
        mediaTitle: 'Janet(s)',
        grandparentTitle: 'The Good Place',
        seasonNumber: 3,
        episodeNumber: 10,
        guid: 'tv.plex.xmltv://episode/The%20Good%20Place/3/10',
      },
      new Date(T0),
      { timeoutMs: 2000 }
    );
  });

  it('asks once per session and keeps the answer while the session is seen', async () => {
    const findAiring = vi.fn(async () => onAir);
    const tv = createLiveTvSessions({ guide: { findAiring }, now });

    await tv.fill(plex, [live()]);
    clock += 20 * 60_000;
    const again = live();
    await tv.fill(plex, [again]);
    clock += 20 * 60_000;
    await tv.fill(plex, [live()]);

    expect(findAiring).toHaveBeenCalledTimes(1);
    expect(again.channelTitle).toBe('Sitcoms');
  });

  it('asks again for the next programme, which Plex plays as a new session', async () => {
    const findAiring = vi.fn(async () => onAir);
    const tv = createLiveTvSessions({ guide: { findAiring }, now });

    await tv.fill(plex, [live()]);
    await tv.fill(plex, [live({ sessionKey: '13', ratingKey: '38390' })]);

    expect(findAiring).toHaveBeenCalledTimes(2);
  });

  it('tries a session the guide could not place again a minute later', async () => {
    const findAiring = vi.fn(async (): Promise<LiveTvAiring | null> => null);
    const tv = createLiveTvSessions({ guide: { findAiring }, now });

    const first = live();
    await tv.fill(plex, [first]);
    clock += 30_000;
    await tv.fill(plex, [live()]);
    expect(first.channelTitle).toBeNull();
    expect(findAiring).toHaveBeenCalledTimes(1);

    findAiring.mockResolvedValue(onAir);
    clock += 30_000;
    const later = live();
    await tv.fill(plex, [later]);
    expect(findAiring).toHaveBeenCalledTimes(2);
    expect(later.channelTitle).toBe('Sitcoms');
  });

  it('leaves a session that names its channel, other media and other servers alone', async () => {
    const findAiring = vi.fn(async () => onAir);
    const tv = createLiveTvSessions({ guide: { findAiring }, now });
    const named = live({ channelTitle: 'ESPN', channelIdentifier: '202' });
    const episode = live({ mediaType: 'episode' });
    const jellyfin = live();

    await tv.fill(plex, [named, episode]);
    await tv.fill({ id: 'server-2', type: 'jellyfin' }, [jellyfin]);

    expect(findAiring).not.toHaveBeenCalled();
    expect(named.channelTitle).toBe('ESPN');
    expect(episode.channelTitle).toBeNull();
    expect(jellyfin.channelTitle).toBeNull();
  });

  it('looks up a film by its title, with no show', async () => {
    const findAiring = vi.fn(async () => onAir);
    const tv = createLiveTvSessions({ guide: { findAiring }, now });

    await tv.fill(plex, [
      live({ grandparentTitle: '', mediaTitle: 'Coherence', seasonNumber: null, guid: undefined }),
    ]);

    expect(findAiring).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTitle: 'Coherence', grandparentTitle: null, guid: null }),
      expect.any(Date),
      expect.anything()
    );
  });

  it('goes on without the channel when the lookup throws', async () => {
    const findAiring = vi.fn(async () => {
      throw new Error('boom');
    });
    const tv = createLiveTvSessions({ guide: { findAiring }, now });
    const session = live();

    await expect(tv.fill(plex, [session])).resolves.toBeUndefined();
    expect(session.channelTitle).toBeNull();
  });
});
