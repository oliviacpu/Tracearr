/**
 * liveTvSession (fork patch): what a Plex Live TV session leaves out, filled in from
 * the server's guide, and whether its transcode keeps up. The guide is a stub, so
 * nothing here touches a server.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));

import type { ProcessedSession } from '../../jobs/poller/types.js';
import type { LiveTvAiring } from '../liveTvGuide.js';
import {
  channelFromGuide,
  createLiveTvSessions,
  lateChannelFields,
  measureLivePace,
} from '../liveTvSession.js';

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

describe('measureLivePace', () => {
  const at = (s: number, offset: number) => ({ at: T0 + s * 1000, offset });

  it('keeps up when the ready point grows a second per second (337 to 356 s in 20 s)', () => {
    expect(measureLivePace([at(0, 337), at(10, 346), at(20, 356)])).toEqual({
      pace: 'keeping_up',
      rate: 0.95,
    });
  });

  it('falls behind when it grows well under real time over the span', () => {
    expect(measureLivePace([at(0, 300), at(60, 340)])).toEqual({
      pace: 'falling_behind',
      rate: 0.67,
    });
  });

  it('measures nothing over less than 20 seconds', () => {
    expect(measureLivePace([at(0, 300), at(15, 301)])).toBeNull();
    expect(measureLivePace([at(0, 300)])).toBeNull();
    expect(measureLivePace([])).toBeNull();
  });

  it('forgives a late segment or two over a short span', () => {
    // 85% over 20 s is 3 s short: one 2-second segment late, not falling behind.
    expect(measureLivePace([at(0, 300), at(20, 317)])?.pace).toBe('keeping_up');
  });

  it('keeps the previous verdict between the thresholds', () => {
    // 92% over a minute: 4.8 s short, under the 95% that clears falling behind.
    const samples = [at(0, 300), at(60, 355.2)];
    expect(measureLivePace(samples, 'falling_behind')?.pace).toBe('falling_behind');
    expect(measureLivePace(samples, 'keeping_up')?.pace).toBe('keeping_up');
    expect(measureLivePace(samples)?.pace).toBe('keeping_up');
  });
});

describe('liveTvSessions.fill: the pace', () => {
  const noGuide = { findAiring: vi.fn(async () => null) };

  function transcoding(offset: number, over: Partial<ProcessedSession> = {}) {
    return live({
      channelTitle: 'Sitcoms',
      state: 'playing',
      transcodeInfo: { speed: 0.8, maxOffsetAvailable: offset },
      ...over,
    });
  }

  it('says nothing until 20 seconds are measured, then keeps up at real time', async () => {
    const tv = createLiveTvSessions({ guide: noGuide, now });
    const first = transcoding(337);
    await tv.fill(plex, [first]);
    clock += 10_000;
    const second = transcoding(346);
    await tv.fill(plex, [second]);
    clock += 10_000;
    const third = transcoding(357);
    await tv.fill(plex, [third]);

    expect(first.transcodeInfo?.livePace).toBeUndefined();
    expect(second.transcodeInfo?.livePace).toBeUndefined();
    expect(third.transcodeInfo).toMatchObject({ livePace: 'keeping_up', livePaceRate: 1 });
    // Plex's own speed is left as it came.
    expect(third.transcodeInfo?.speed).toBe(0.8);
  });

  it('measures over the last minute only', async () => {
    const tv = createLiveTvSessions({ guide: noGuide, now });
    // A slow first minute, then real time for a minute: only the last minute counts.
    let offset = 0;
    for (let s = 0; s <= 60; s += 10) {
      await tv.fill(plex, [transcoding(offset)]);
      clock += 10_000;
      offset += 5;
    }
    let last = transcoding(offset);
    for (let s = 0; s <= 60; s += 10) {
      last = transcoding(offset);
      await tv.fill(plex, [last]);
      clock += 10_000;
      offset += 10;
    }
    expect(last.transcodeInfo).toMatchObject({ livePace: 'keeping_up', livePaceRate: 1 });
  });

  it('falls behind, and keeps saying so until it is clearly back', async () => {
    const tv = createLiveTvSessions({ guide: noGuide, now });
    let offset = 100;
    let last = transcoding(offset);
    // A sighting every 10 seconds for a minute, the ready point growing `rate` seconds a second.
    const feed = async (rate: number) => {
      for (let s = 0; s < 60; s += 10) {
        clock += 10_000;
        offset += 10 * rate;
        last = transcoding(offset);
        await tv.fill(plex, [last]);
      }
    };
    await tv.fill(plex, [last]);

    await feed(0.7);
    expect(last.transcodeInfo).toMatchObject({ livePace: 'falling_behind', livePaceRate: 0.7 });

    // 93% for a minute isn't enough to clear it...
    await feed(0.93);
    expect(last.transcodeInfo).toMatchObject({ livePace: 'falling_behind', livePaceRate: 0.93 });

    // ...real time is.
    await feed(1);
    expect(last.transcodeInfo).toMatchObject({ livePace: 'keeping_up', livePaceRate: 1 });
  });

  it('counts a throttled transcoder as keeping up and starts measuring again after it', async () => {
    const tv = createLiveTvSessions({ guide: noGuide, now });
    const throttled = transcoding(500, {
      transcodeInfo: { maxOffsetAvailable: 500, throttled: true, speed: 0.1 },
    });
    await tv.fill(plex, [throttled]);
    expect(throttled.transcodeInfo).toMatchObject({ livePace: 'keeping_up' });
    expect(throttled.transcodeInfo?.livePaceRate).toBeUndefined();

    clock += 10_000;
    const after = transcoding(502);
    await tv.fill(plex, [after]);
    // Too soon to measure: the last verdict stands, with no rate.
    expect(after.transcodeInfo?.livePace).toBe('keeping_up');
    expect(after.transcodeInfo?.livePaceRate).toBeUndefined();
  });

  it('says nothing while paused, and measures afresh after', async () => {
    const tv = createLiveTvSessions({ guide: noGuide, now });
    await tv.fill(plex, [transcoding(100)]);
    clock += 30_000;
    const paused = transcoding(101, { state: 'paused' });
    await tv.fill(plex, [paused]);
    expect(paused.transcodeInfo?.livePace).toBeUndefined();

    clock += 30_000;
    const resumed = transcoding(102);
    await tv.fill(plex, [resumed]);
    // The paused stretch is not measured against it.
    expect(resumed.transcodeInfo?.livePace).toBeUndefined();
  });

  it('starts again when the ready point goes back (a restarted transcode)', async () => {
    const tv = createLiveTvSessions({ guide: noGuide, now });
    await tv.fill(plex, [transcoding(900)]);
    clock += 30_000;
    const restarted = transcoding(12);
    await tv.fill(plex, [restarted]);
    expect(restarted.transcodeInfo?.livePace).toBeUndefined();
  });

  it('leaves direct play, other media and other servers without a pace', async () => {
    const tv = createLiveTvSessions({ guide: noGuide, now });
    const direct = transcoding(0, { transcodeInfo: null });
    const movie = transcoding(100, { mediaType: 'movie' });
    const jellyfin = transcoding(100);
    for (let i = 0; i < 4; i++) {
      await tv.fill(plex, [direct, movie]);
      await tv.fill({ id: 'server-2', type: 'jellyfin' }, [jellyfin]);
      clock += 10_000;
      if (movie.transcodeInfo?.maxOffsetAvailable !== undefined) {
        movie.transcodeInfo.maxOffsetAvailable += 10;
      }
    }
    expect(direct.transcodeInfo).toBeNull();
    expect(movie.transcodeInfo?.livePace).toBeUndefined();
    expect(jellyfin.transcodeInfo?.livePace).toBeUndefined();
  });
});
