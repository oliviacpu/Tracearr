/**
 * Plex Live TV guide parsing
 *
 * A Plex Live TV session says what is on but not on which channel when its guide is an
 * XMLTV file (Tunarr, for example): `/status/sessions` carries no `sourceTitle` and no
 * channel fields on its Media. The DVR's guide does. Each DVR names its guide provider
 * (`epgIdentifier`, e.g. `tv.plex.providers.epg.xmltv:4`), and the provider's grid lists
 * every airing with its channel and time window on its Media.
 */

import {
  parseOptionalNumber,
  parseString,
  parseOptionalBoundedString,
} from '../../../utils/parsing.js';

/** One airing of a programme on one channel, from a guide grid. */
export interface PlexGuideAiring {
  /** 'episode' or 'movie' (Plex's metadata type of the programme). */
  type: string;
  /** The programme's guide id, which a Live TV session playing it carries as its `guid`. */
  guid: string | null;
  title: string;
  /** The show of an episode. */
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  /** Epoch milliseconds. */
  beginsAt: number;
  endsAt: number;
  channel: PlexGuideChannel;
}

export interface PlexGuideChannel {
  /** The guide's own channel id, the grid's `channel=` filter. */
  id: string | null;
  /** The channel number viewers know (Plex's virtual channel number). */
  number: string | null;
  /** Plex's display title, usually the number and the name ("5 Sitcoms"). */
  title: string | null;
  /** The name alone ("Sitcoms"). */
  callSign: string | null;
  /** The logo: a server path or an absolute URL. */
  thumb: string | null;
}

/** A guide provider id is `<provider identifier>:<number>`; anything else isn't addressed. */
const GUIDE_ID = /^[A-Za-z][A-Za-z0-9._-]*:\d+$/;

/** The guide providers of the server's DVRs, from `/livetv/dvrs`. */
export function parseLiveTvGuideIds(data: unknown): string[] {
  const dvrs = (data as { MediaContainer?: { Dvr?: unknown } } | null)?.MediaContainer?.Dvr;
  if (!Array.isArray(dvrs)) return [];
  const ids = dvrs
    .map((dvr) => parseString((dvr as Record<string, unknown>).epgIdentifier))
    .filter((id) => GUIDE_ID.test(id));
  return [...new Set(ids)];
}

export function isGuideId(value: string): boolean {
  return GUIDE_ID.test(value);
}

/** A present, non-blank string or number as a string, cut to the column size Tracearr uses for it. */
function optional(value: unknown, max = 500): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return parseOptionalBoundedString(String(value).trim(), max) || null;
}

/** A grid answer as one airing per channel it is on; an entry without a time window is dropped. */
export function parseGuideGrid(data: unknown): PlexGuideAiring[] {
  const items = (data as { MediaContainer?: { Metadata?: unknown } } | null)?.MediaContainer
    ?.Metadata;
  if (!Array.isArray(items)) return [];
  const airings: PlexGuideAiring[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const media = Array.isArray(item.Media) ? (item.Media as Record<string, unknown>[]) : [];
    for (const m of media) {
      const beginsAt = parseOptionalNumber(m.beginsAt);
      const endsAt = parseOptionalNumber(m.endsAt);
      if (beginsAt === undefined || endsAt === undefined) continue;
      airings.push({
        type: parseString(item.type),
        guid: optional(item.guid),
        title: parseString(item.title),
        showTitle: optional(item.grandparentTitle, 255),
        seasonNumber: parseOptionalNumber(item.parentIndex) ?? null,
        episodeNumber: parseOptionalNumber(item.index) ?? null,
        year: parseOptionalNumber(item.year) ?? null,
        beginsAt: beginsAt * 1000,
        endsAt: endsAt * 1000,
        channel: {
          id: optional(m.channelID, 100),
          number: optional(m.channelVcn, 100),
          title: optional(m.channelTitle, 255),
          callSign: optional(m.channelCallSign, 255),
          thumb: optional(m.channelThumb),
        },
      });
    }
  }
  return airings;
}
