/**
 * Which channel a Live TV session is watching, from the media server's guide.
 *
 * Plex names the channel in a Live TV session only for some guides: with an XMLTV guide
 * (Tunarr, say) `/status/sessions` has the programme but no `sourceTitle` and no channel
 * fields, so Tracearr stores none. The DVR's guide grid lists every airing with its channel,
 * so the programme the session is playing, on the air when it played, names its channel,
 * and the channel's following airing is what's on next.
 *
 * Lookups are best effort: a server that isn't Plex, has no DVR, doesn't answer within the
 * timeout, or airs the programme on more than one channel at that moment gives null, and
 * the caller shows what the session itself has.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { PlexClient } from './mediaServer/plex/client.js';
import type { PlexGuideAiring, PlexGuideChannel } from './mediaServer/plex/guide.js';

/** What a lookup needs from the session: its server and the programme it plays. */
export interface LiveTvProgrammeRef {
  serverId: string;
  mediaTitle: string;
  grandparentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** The programme's guide id (Plex's `guid` on the session), when the session has one. */
  guid?: string | null;
}

export interface LiveTvAiring {
  channel: PlexGuideChannel;
  /** Epoch ms of the programme's slot on that channel. */
  beginsAt: number;
  endsAt: number;
  /** The channel's next programme, when asked for and the guide has one. */
  next: PlexGuideAiring | null;
}

export interface GuideQuery {
  from: number;
  to: number;
  channelId?: string;
  startingBetween?: boolean;
}

/** A server's guide, as the lookup reads it. */
export interface GuideSource {
  guideIds(): Promise<string[]>;
  airings(guideId: string, query: GuideQuery): Promise<PlexGuideAiring[]>;
}

export interface LiveTvGuideDeps {
  /** The server's guide, or null when it has none Tracearr can read (not Plex, gone). */
  sourceFor(serverId: string): Promise<GuideSource | null>;
  now?: () => number;
  /** The whole lookup's budget; past it the caller goes on without the channel. */
  timeoutMs?: number;
}

const MINUTE = 60_000;
/** Server rows change rarely; a URL or token edit reaches the lookup within this. */
const SOURCE_TTL_MS = 30_000;
/** A DVR added or removed shows up within this. */
const GUIDE_IDS_TTL_MS = 10 * MINUTE;
/** A guide's past doesn't change; a refreshed guide's future reaches the lookup within this. */
const GRID_TTL_MS = 10 * MINUTE;
/** How far past the programme's end its channel's next airing is looked for. */
const NEXT_HORIZON_MS = 6 * 60 * MINUTE;
const DEFAULT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;
const WARN_EVERY_MS = 5 * MINUTE;
const CACHE_PRUNE_AT = 200;

interface Entry<T> {
  value: Promise<T>;
  expires: number;
}

/** Titles as the guide and the session may spell them: Unicode-normalised, trimmed, any case. */
const norm = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

/**
 * Whether a guide airing is the programme the session plays: an episode by its show and its
 * season and episode (its title when either side lacks the numbers), a film by its title.
 */
export function airingMatches(airing: PlexGuideAiring, session: LiveTvProgrammeRef): boolean {
  if (session.grandparentTitle) {
    if (!airing.showTitle || norm(airing.showTitle) !== norm(session.grandparentTitle)) {
      return false;
    }
    if (
      session.seasonNumber !== null &&
      session.episodeNumber !== null &&
      airing.seasonNumber !== null &&
      airing.episodeNumber !== null
    ) {
      return (
        airing.seasonNumber === session.seasonNumber &&
        airing.episodeNumber === session.episodeNumber
      );
    }
    return norm(airing.title) === norm(session.mediaTitle);
  }
  return airing.showTitle === null && norm(airing.title) === norm(session.mediaTitle);
}

const channelKey = (c: PlexGuideChannel): string => c.id ?? c.number ?? c.title ?? c.callSign ?? '';

export function createLiveTvGuide(deps: LiveTvGuideDeps) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const caches = {
    source: new Map<string, Entry<GuideSource | null>>(),
    guideIds: new Map<string, Entry<string[]>>(),
    grid: new Map<string, Entry<PlexGuideAiring[]>>(),
    next: new Map<string, Entry<PlexGuideAiring | null>>(),
  };
  let lastWarnAt = -Infinity;

  /** One request per key while it's fresh, shared by concurrent callers; a failure isn't kept. */
  function cached<T>(
    map: Map<string, Entry<T>>,
    key: string,
    ttl: number,
    load: () => Promise<T>
  ): Promise<T> {
    const at = now();
    const hit = map.get(key);
    if (hit && hit.expires > at) return hit.value;
    if (map.size >= CACHE_PRUNE_AT) {
      for (const [k, entry] of map) if (entry.expires <= at) map.delete(k);
    }
    const value = load();
    map.set(key, { value, expires: at + ttl });
    value.catch(() => {
      if (map.get(key)?.value === value) map.delete(key);
    });
    return value;
  }

  async function nextOn(
    source: GuideSource,
    serverId: string,
    guideId: string,
    airing: PlexGuideAiring
  ): Promise<PlexGuideAiring | null> {
    const channelId = airing.channel.id;
    if (!channelId) return null;
    return cached(
      caches.next,
      `${serverId}|${guideId}|${channelId}|${airing.endsAt}`,
      GRID_TTL_MS,
      async () => {
        const later = await source.airings(guideId, {
          from: airing.endsAt,
          to: airing.endsAt + NEXT_HORIZON_MS,
          channelId,
          startingBetween: true,
        });
        return (
          later
            .filter((a) => a.channel.id === channelId && a.beginsAt >= airing.endsAt)
            .sort((a, b) => a.beginsAt - b.beginsAt)[0] ?? null
        );
      }
    );
  }

  async function lookup(
    session: LiveTvProgrammeRef,
    at: number,
    withNext: boolean
  ): Promise<LiveTvAiring | null> {
    const { serverId } = session;
    const source = await cached(caches.source, serverId, SOURCE_TTL_MS, () =>
      deps.sourceFor(serverId)
    );
    if (!source) return null;
    const guideIds = await cached(caches.guideIds, serverId, GUIDE_IDS_TTL_MS, () =>
      source.guideIds()
    );

    // Asked by the minute, so every session and destination in that minute shares one grid.
    const from = Math.floor(at / MINUTE) * MINUTE;
    for (const guideId of guideIds) {
      const airings = await cached(caches.grid, `${serverId}|${guideId}|${from}`, GRID_TTL_MS, () =>
        source.airings(guideId, { from, to: from + MINUTE })
      );
      // The guide id names the programme exactly; titles are the fallback for a session without one.
      const byGuid = session.guid ? airings.filter((a) => a.guid === session.guid) : [];
      const matches = byGuid.length > 0 ? byGuid : airings.filter((a) => airingMatches(a, session));
      const onAir = matches.filter((a) => a.beginsAt <= at && at < a.endsAt);
      const pool = onAir.length > 0 ? onAir : matches;
      // The same programme on two channels at once can't say which one the session tuned.
      const airing = pool[0];
      if (!airing || new Set(pool.map((a) => channelKey(a.channel))).size !== 1) continue;
      const next = withNext
        ? await nextOn(source, serverId, guideId, airing).catch(() => null)
        : null;
      return { channel: airing.channel, beginsAt: airing.beginsAt, endsAt: airing.endsAt, next };
    }
    return null;
  }

  return {
    /**
     * The channel the session's programme aired on at `at` (a moment it was playing), and
     * with `next` the channel's following programme. Null when that can't be told in time
     * (`timeoutMs`, else the guide's own budget); a request still running is kept for the
     * next lookup.
     */
    async findAiring(
      session: LiveTvProgrammeRef,
      at: Date,
      options: { next?: boolean; timeoutMs?: number } = {}
    ): Promise<LiveTvAiring | null> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), options.timeoutMs ?? timeoutMs);
      });
      try {
        return await Promise.race([lookup(session, at.getTime(), options.next ?? false), timeout]);
      } catch (error) {
        if (now() - lastWarnAt >= WARN_EVERY_MS) {
          lastWarnAt = now();
          console.warn(
            `[LiveTvGuide] Couldn't read the Live TV guide of server ${session.serverId}:`,
            error instanceof Error ? error.message : error
          );
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    /** Forget everything (tests). */
    clear(): void {
      for (const map of Object.values(caches)) map.clear();
      lastWarnAt = -Infinity;
    },
  };
}

export type LiveTvGuide = ReturnType<typeof createLiveTvGuide>;

/** A Plex server's guide through Tracearr's own connection to it; other servers have none. */
async function plexGuideSource(serverId: string): Promise<GuideSource | null> {
  const [row] = await db
    .select({ type: servers.type, url: servers.url, token: servers.token })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (row?.type !== 'plex') return null;
  const client = new PlexClient({ url: row.url, token: row.token });
  return {
    guideIds: () => client.getLiveTvGuideIds(REQUEST_TIMEOUT_MS),
    airings: (guideId, query) => client.getGuideAirings(guideId, query, REQUEST_TIMEOUT_MS),
  };
}

export const liveTvGuide = createLiveTvGuide({ sourceFor: plexGuideSource });
