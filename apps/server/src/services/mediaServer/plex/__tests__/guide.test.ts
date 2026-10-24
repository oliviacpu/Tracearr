import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlexClient } from '../client.js';
import { parseGuideGrid, parseLiveTvGuideIds } from '../guide.js';

vi.mock('../../../../utils/http.js', () => ({
  fetchJson: vi.fn(),
  fetchText: vi.fn(),
  plexHeaders: vi.fn().mockReturnValue({ 'X-Plex-Token': 'test-token' }),
}));

import { fetchJson } from '../../../../utils/http.js';

const mockFetchJson = vi.mocked(fetchJson);

// Trimmed from a real Plex server's /livetv/dvrs with a Tunarr XMLTV guide.
const dvrs = {
  MediaContainer: {
    size: 1,
    Dvr: [
      {
        key: '4',
        lineupTitle: 'Guide',
        lineup: 'lineup://tv.plex.providers.epg.xmltv/http%3A%2F%2F127.0.0.1%2Fxmltv.xml#Guide',
        epgIdentifier: 'tv.plex.providers.epg.xmltv:4',
        Device: [{ key: '1', uri: 'http://127.0.0.1:8000', protocol: 'livetv' }],
      },
    ],
  },
};

// Trimmed from the same server's /tv.plex.providers.epg.xmltv:4/grid: an episode and a film.
const gridFixture = {
  MediaContainer: {
    size: 2,
    Metadata: [
      {
        ratingKey: 'tv%2Eplex%2Exmltv%3A%2F%2Fepisode%2FGhosts%2520%2528US%2529%2F4%2F19',
        guid: 'tv.plex.xmltv://episode/Ghosts%20%28US%29/4/19',
        type: 'episode',
        title: 'Pinkus Returns',
        grandparentTitle: 'Ghosts (US)',
        parentTitle: 'Season 4',
        index: 19,
        parentIndex: 4,
        grandparentThumb: 'https://guide.example.com/media/artwork/ghosts-poster.jpg?v=1',
        duration: 1380000,
        onAir: true,
        Media: [
          {
            id: 9,
            channelCallSign: 'Sitcoms',
            channelIdentifier: 'C3.51.tunarr.com',
            channelThumb: 'https://guide.example.com/images/uploads/sitcoms_icon.png?v=1',
            channelTitle: '3 Sitcoms',
            channelVcn: '3',
            protocol: 'livetv',
            beginsAt: 1792852200,
            endsAt: 1792853580,
            onAir: true,
            channelID: 4,
          },
        ],
        Channel: [{ id: 4, filter: 'channel=4', tag: '3 Sitcoms' }],
      },
      {
        ratingKey: 'tv%2Eplex%2Exmltv%3A%2F%2Fmovie%2FLittle%2520Big%2520Man',
        guid: 'tv.plex.xmltv://movie/Little%20Big%20Man',
        type: 'movie',
        title: 'Little Big Man',
        thumb: 'https://guide.example.com/media/artwork/lbm-poster.jpg?v=1',
        duration: 8460000,
        Media: [
          {
            id: 26,
            channelCallSign: 'Drama',
            channelIdentifier: 'C4.52.tunarr.com',
            channelTitle: '4 Drama',
            channelVcn: '4',
            protocol: 'livetv',
            beginsAt: 1792898100,
            endsAt: 1792906560,
            channelID: 1,
          },
        ],
        Genre: [{ id: 28, filter: 'genre=28', tag: 'Western' }],
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseLiveTvGuideIds', () => {
  it("lists each DVR's guide provider once", () => {
    const twice = {
      MediaContainer: { Dvr: [...dvrs.MediaContainer.Dvr, ...dvrs.MediaContainer.Dvr] },
    };
    expect(parseLiveTvGuideIds(twice)).toEqual(['tv.plex.providers.epg.xmltv:4']);
  });

  it('has none without a DVR, and drops an identifier it would not address', () => {
    expect(parseLiveTvGuideIds({ MediaContainer: { size: 0 } })).toEqual([]);
    expect(parseLiveTvGuideIds(null)).toEqual([]);
    expect(
      parseLiveTvGuideIds({ MediaContainer: { Dvr: [{ epgIdentifier: '../library:1' }] } })
    ).toEqual([]);
  });
});

describe('parseGuideGrid', () => {
  it('reads each airing with its programme, slot and channel', () => {
    const [episode, film] = parseGuideGrid(gridFixture);

    expect(episode).toEqual({
      type: 'episode',
      guid: 'tv.plex.xmltv://episode/Ghosts%20%28US%29/4/19',
      title: 'Pinkus Returns',
      showTitle: 'Ghosts (US)',
      seasonNumber: 4,
      episodeNumber: 19,
      year: null,
      beginsAt: 1792852200_000,
      endsAt: 1792853580_000,
      channel: {
        id: '4',
        number: '3',
        title: '3 Sitcoms',
        callSign: 'Sitcoms',
        thumb: 'https://guide.example.com/images/uploads/sitcoms_icon.png?v=1',
      },
    });
    expect(film).toMatchObject({
      type: 'movie',
      title: 'Little Big Man',
      showTitle: null,
      seasonNumber: null,
      channel: { id: '1', number: '4', callSign: 'Drama', thumb: null },
    });
  });

  it('gives one airing per channel and skips media without a time window', () => {
    const item = gridFixture.MediaContainer.Metadata[0]!;
    const media = item.Media[0]!;
    const airings = parseGuideGrid({
      MediaContainer: {
        Metadata: [
          {
            ...item,
            Media: [
              media,
              { ...media, channelID: 9, channelVcn: '9' },
              { channelTitle: 'No slot' },
            ],
          },
        ],
      },
    });
    expect(airings.map((a) => a.channel.number)).toEqual(['3', '9']);
  });

  it('is empty for an answer that is not a grid', () => {
    expect(parseGuideGrid({ MediaContainer: { size: 0 } })).toEqual([]);
    expect(parseGuideGrid('nope')).toEqual([]);
  });
});

describe('PlexClient guide reads', () => {
  const client = new PlexClient({ url: 'http://plex.local:32400/', token: 'test-token' });

  it("lists the server's guides with a short timeout", async () => {
    mockFetchJson.mockResolvedValueOnce(dvrs);

    await expect(client.getLiveTvGuideIds(3000)).resolves.toEqual([
      'tv.plex.providers.epg.xmltv:4',
    ]);
    expect(mockFetchJson).toHaveBeenCalledWith(
      'http://plex.local:32400/livetv/dvrs',
      expect.objectContaining({ timeout: 3000 })
    );
  });

  it('asks the grid for what is on the air in a window', async () => {
    mockFetchJson.mockResolvedValueOnce(gridFixture);

    const airings = await client.getGuideAirings('tv.plex.providers.epg.xmltv:4', {
      from: 1792852800_000,
      to: 1792852860_000,
    });

    expect(airings).toHaveLength(2);
    expect(mockFetchJson).toHaveBeenCalledWith(
      'http://plex.local:32400/tv.plex.providers.epg.xmltv:4/grid?beginsAt%3C=1792852860&endsAt%3E=1792852800',
      expect.objectContaining({ headers: { 'X-Plex-Token': 'test-token' } })
    );
  });

  it("asks for one channel's programmes starting in a window", async () => {
    mockFetchJson.mockResolvedValueOnce({ MediaContainer: { size: 0 } });

    await client.getGuideAirings('tv.plex.providers.epg.xmltv:4', {
      from: 1792853580_000,
      to: 1792875180_000,
      channelId: '4',
      startingBetween: true,
    });

    expect(mockFetchJson).toHaveBeenCalledWith(
      'http://plex.local:32400/tv.plex.providers.epg.xmltv:4/grid?beginsAt%3E=1792853580&beginsAt%3C=1792875180&channel=4',
      expect.anything()
    );
  });

  it('never requests a guide id it would not address', async () => {
    await expect(
      client.getGuideAirings('../../library/sections:1', { from: 0, to: 1 })
    ).resolves.toEqual([]);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});
