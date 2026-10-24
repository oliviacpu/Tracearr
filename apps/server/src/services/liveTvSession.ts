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
 *
 * Plex's `speed` for a Live TV transcode is instantaneous (4.5x, then 0.7x 20 seconds later)
 * and says little: a live source arrives in real time, so a transcoder can't run ahead of it
 * for long, and below 1x it is usually waiting for input. What matters is whether it keeps
 * up, and that shows in `maxOffsetAvailable`, the point the transcoder has ready: it grows a
 * second per second when the transcoder keeps up. Each sighting of a session (poll or SSE)
 * adds a sample, and the growth over the last minute (at least 20 seconds of it) gives
 * `livePace` and `livePaceRate` on the session's transcode info. Samples live in memory; a
 * restart measures again from scratch.
 */

import type { LivePace, TranscodeInfo } from '@tracearr/shared';
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

/** The span the pace is measured over: the last minute of samples... */
const PACE_WINDOW_MS = 60_000;
/** ...once they cover at least this much. */
const PACE_MIN_SPAN_MS = 20_000;
/** Samples closer together than this (a poll and an SSE fetch at once) count once. */
const PACE_MIN_GAP_MS = 1_000;
/** Falling behind: the ready point grew less than 90% of the time that passed... */
const FALLING_BEHIND_BELOW = 0.9;
/** ...and is more than this many seconds short, two 2-second segments (one late segment isn't). */
const BEHIND_SLACK_S = 4;
/** Back to keeping up from 95%, so a pace near the line doesn't flip at every poll. */
const KEEPING_UP_FROM = 0.95;
/** The ready point going back more than this (a restarted transcode) starts measuring again. */
const OFFSET_RESET_S = 1;

export interface PaceSample {
  /** Epoch ms of the sighting. */
  at: number;
  /** maxOffsetAvailable then, in seconds. */
  offset: number;
}

/**
 * The pace over the samples' span (oldest to newest), or null when they cover less than
 * PACE_MIN_SPAN_MS. Between the two thresholds the previous verdict holds (keeping up when
 * there is none), and a ready point at most BEHIND_SLACK_S short is keeping up.
 */
export function measureLivePace(
  samples: readonly PaceSample[],
  previous?: LivePace
): { pace: LivePace; rate: number } | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || last.at - first.at < PACE_MIN_SPAN_MS) return null;
  const spanS = (last.at - first.at) / 1000;
  const grownS = last.offset - first.offset;
  const rate = grownS / spanS;
  const shortS = spanS - grownS;
  let pace: LivePace;
  if (rate < FALLING_BEHIND_BELOW && shortS > BEHIND_SLACK_S) pace = 'falling_behind';
  else if (rate >= KEEPING_UP_FROM || shortS <= BEHIND_SLACK_S) pace = 'keeping_up';
  else pace = previous ?? 'keeping_up';
  return { pace, rate: Math.round(rate * 100) / 100 };
}

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

function setPace(info: TranscodeInfo, pace: LivePace, rate?: number): void {
  info.livePace = pace;
  if (rate === undefined) delete info.livePaceRate;
  else info.livePaceRate = rate;
}

interface ChannelEntry {
  fields: LiveTvChannelFields | null;
  retryAt: number;
  seenAt: number;
}

interface PaceEntry {
  samples: PaceSample[];
  pace?: LivePace;
  seenAt: number;
}

const sessionKeyOf = (serverId: string, session: ProcessedSession): string =>
  `${serverId}|${session.sessionKey}|${session.ratingKey}`;

export function createLiveTvSessions(deps: LiveTvSessionDeps) {
  const now = deps.now ?? Date.now;
  const channels = new Map<string, ChannelEntry>();
  const paces = new Map<string, PaceEntry>();

  function forgetUnseen(at: number): void {
    for (const map of [channels, paces]) {
      for (const [key, entry] of map) {
        if (at - entry.seenAt > FORGET_AFTER_MS) map.delete(key);
      }
    }
  }

  /** Add this sighting's sample and put the pace on the session's transcode info. */
  function trackPace(serverId: string, session: ProcessedSession, at: number): void {
    const info = session.transcodeInfo;
    const offset = info?.maxOffsetAvailable;
    if (!info || offset === undefined) return;
    const key = sessionKeyOf(serverId, session);
    // Paused, the ready point may stop growing for reasons that aren't the transcoder's.
    if (session.state === 'paused') {
      paces.delete(key);
      return;
    }
    let entry = paces.get(key);
    if (!entry) {
      entry = { samples: [], seenAt: at };
      paces.set(key, entry);
    }
    entry.seenAt = at;
    // Throttled, Plex holds back a transcoder that is ahead: keeping up, with nothing to measure.
    if (info.throttled) {
      entry.samples = [];
      entry.pace = 'keeping_up';
      setPace(info, 'keeping_up');
      return;
    }
    const prev = entry.samples[entry.samples.length - 1];
    if (prev && offset < prev.offset - OFFSET_RESET_S) entry.samples = [];
    if (!prev || at - prev.at >= PACE_MIN_GAP_MS || entry.samples.length === 0) {
      entry.samples.push({ at, offset });
    }
    // Keep the newest sample at least a window old as the span's start, and nothing older.
    const windowStart = at - PACE_WINDOW_MS;
    while (entry.samples.length > 2 && (entry.samples[1]?.at ?? Infinity) <= windowStart) {
      entry.samples.shift();
    }
    const measured = measureLivePace(entry.samples, entry.pace);
    if (!measured) {
      if (entry.pace) setPace(info, entry.pace);
      return;
    }
    entry.pace = measured.pace;
    setPace(info, measured.pace, measured.rate);
  }

  async function fillChannel(
    serverId: string,
    session: ProcessedSession,
    at: number
  ): Promise<void> {
    const key = sessionKeyOf(serverId, session);
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
     * from the guide when the session names none, and whether a transcode keeps up. Other
     * servers and media are untouched.
     */
    async fill(server: { id: string; type: string }, sessions: ProcessedSession[]): Promise<void> {
      if (server.type !== 'plex') return;
      const at = now();
      forgetUnseen(at);
      for (const s of sessions) if (s.mediaType === 'live') trackPace(server.id, s, at);
      await Promise.all(
        sessions
          .filter((s) => s.mediaType === 'live' && !s.channelTitle)
          .map((s) => fillChannel(server.id, s, at))
      );
    },
    /** Forget everything (tests). */
    clear(): void {
      channels.clear();
      paces.clear();
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
