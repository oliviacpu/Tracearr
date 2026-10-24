/**
 * Live TV facts a Plex session leaves out (fork patch)
 *
 * With an XMLTV guide (Tunarr, say) Plex names no channel on a Live TV session: no
 * `sourceTitle` and no channel fields on its Media, so Tracearr had none to store or show.
 * The server's guide does name it (liveTvGuide.ts), so a Live TV session without a channel
 * takes the channel of the guide airing it plays, matched by the session's `guid` (the
 * programme's guide id) or, without one, its titles.
 *
 * A session's channel is looked up once and kept while the session is seen; Plex starts a
 * new session at every programme boundary, so a session stays on one channel. A failed or
 * slow lookup is tried again a minute later. The guide's own caches mean every session on a
 * server in the same minute shares one grid request.
 */

import type { ProcessedSession } from '../jobs/poller/types.js';
import type { PlexGuideChannel } from './mediaServer/plex/guide.js';
import { liveTvGuide, type LiveTvGuide } from './liveTvGuide.js';

/** The channel columns a session stores. */
export type LiveTvChannelFields = Pick<
  ProcessedSession,
  'channelTitle' | 'channelIdentifier' | 'channelThumb'
>;

export interface LiveTvSessionDeps {
  guide: Pick<LiveTvGuide, 'findAiring'>;
  now?: () => number;
}

/** How long a lookup may hold up a poll; a slower answer is cached for the next one. */
const LOOKUP_TIMEOUT_MS = 2_000;
/** A session whose channel couldn't be found is asked about again after this. */
const RETRY_AFTER_MS = 60_000;
/** A session not seen for this long is forgotten. */
const FORGET_AFTER_MS = 30 * 60_000;

/**
 * A guide channel as the session columns hold one: the name alone ("Sitcoms", the call
 * sign, else the title without its number), the number viewers know ("5") and the logo.
 * Null when the guide gives neither a name nor a number.
 */
export function channelFromGuide(channel: PlexGuideChannel): LiveTvChannelFields | null {
  const { number, title, callSign, thumb } = channel;
  const titleName =
    title && number && title.startsWith(`${number} `) ? title.slice(number.length + 1) : title;
  const name = callSign || titleName || number;
  if (!name) return null;
  return { channelTitle: name, channelIdentifier: number, channelThumb: thumb };
}

/**
 * The channel columns to write onto a recorded session that has none yet, once the guide
 * named the channel after the session was recorded. Empty otherwise: a stored channel is
 * never changed.
 */
export function lateChannelFields(
  stored: { channelTitle: string | null },
  processed: LiveTvChannelFields
): Partial<LiveTvChannelFields> {
  if (stored.channelTitle || !processed.channelTitle) return {};
  return {
    channelTitle: processed.channelTitle,
    channelIdentifier: processed.channelIdentifier,
    channelThumb: processed.channelThumb,
  };
}

interface ChannelEntry {
  fields: LiveTvChannelFields | null;
  retryAt: number;
  seenAt: number;
}

export function createLiveTvSessions(deps: LiveTvSessionDeps) {
  const now = deps.now ?? Date.now;
  const channels = new Map<string, ChannelEntry>();

  function forgetUnseen(at: number): void {
    for (const [key, entry] of channels) {
      if (at - entry.seenAt > FORGET_AFTER_MS) channels.delete(key);
    }
  }

  async function fillChannel(
    serverId: string,
    session: ProcessedSession,
    at: number
  ): Promise<void> {
    const key = `${serverId}|${session.sessionKey}|${session.ratingKey}`;
    let entry = channels.get(key);
    if (!entry || (!entry.fields && entry.retryAt <= at)) {
      const airing = await deps.guide
        .findAiring(
          {
            serverId,
            mediaTitle: session.mediaTitle,
            grandparentTitle: session.grandparentTitle || null,
            seasonNumber: session.seasonNumber,
            episodeNumber: session.episodeNumber,
            guid: session.guid ?? null,
          },
          new Date(at),
          { timeoutMs: LOOKUP_TIMEOUT_MS }
        )
        .catch(() => null);
      entry = {
        fields: airing ? channelFromGuide(airing.channel) : null,
        retryAt: at + RETRY_AFTER_MS,
        seenAt: at,
      };
      channels.set(key, entry);
    }
    entry.seenAt = at;
    if (entry.fields) Object.assign(session, entry.fields);
  }

  return {
    /**
     * Fill in what Plex leaves out of the server's Live TV sessions, in place: the channel
     * from the guide when the session names none. Other servers and media are untouched.
     */
    async fill(server: { id: string; type: string }, sessions: ProcessedSession[]): Promise<void> {
      if (server.type !== 'plex') return;
      const at = now();
      forgetUnseen(at);
      await Promise.all(
        sessions
          .filter((s) => s.mediaType === 'live' && !s.channelTitle)
          .map((s) => fillChannel(server.id, s, at))
      );
    },
    /** Forget everything (tests). */
    clear(): void {
      channels.clear();
    },
  };
}

export const liveTvSessions = createLiveTvSessions({ guide: liveTvGuide });

/** The poller's and the SSE path's hook: see createLiveTvSessions().fill. */
export function fillPlexLiveTv(
  server: { id: string; type: string },
  sessions: ProcessedSession[]
): Promise<void> {
  return liveTvSessions.fill(server, sessions);
}
