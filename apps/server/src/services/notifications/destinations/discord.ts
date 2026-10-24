import {
  DESTINATION_TEXT_PROFILES,
  DESTINATION_TYPES,
  escapeDiscordMarkdown,
  escapeFor,
  fitText,
  isPlacedLocal,
  LOCAL_NETWORK_COUNTRY,
  POSTER_IMAGE_SIZE,
} from '@tracearr/shared';
import { proxyImage } from '../../imageProxy.js';
import { liveTvGuide, type LiveTvAiring } from '../../liveTvGuide.js';
import type { PlexGuideAiring } from '../../mediaServer/plex/guide.js';
import { itemGenres } from '../itemGenres.js';
import { mediaHeadline, mediaSubtitle, qualityMoves } from '../formatters/media.js';
import { formatPluginUpdateMessage } from '../formatters/pluginUpdate.js';
import { formatServerUpdateMessage, formatTracearrUpdateMessage } from '../formatters/updates.js';
import {
  formatViolationDetailsForDiscord,
  getSeverityInfo,
  type DiscordField,
} from '../formatters/violation.js';
import { buildMediaLinks } from '../mediaLinks.js';
import { toNotificationPayload } from '../types.js';
import { deliverFetch } from './fetch.js';
import { ownText, textOf } from './overrides.js';
import {
  formatDuration,
  getMediaDisplay,
  getPlaybackType,
  getUserDisplayName,
} from './sessionText.js';
import type {
  MediaAddedContext,
  MediaUpgradedContext,
  NotificationPayload,
  PluginUpdateContext,
  ServerContext,
  ServerUpdateContext,
  SessionContext,
  TracearrUpdateContext,
  ViolationContext,
} from '../types.js';
import type { DeliverContext, DestinationType } from './types.js';

const PROFILE = DESTINATION_TEXT_PROFILES.discord;
const EMBED_TOTAL = 6000;

export interface DiscordConfig {
  webhookUrl: string;
}

/**
 * Discord will not fetch an image from the user's own network, and most installs are not
 * reachable from the internet, so a poster travels as an upload the embed points at.
 * The avatar cannot: `avatar_url` rejects the attachment scheme, so it names a public
 * asset in the Tracearr repo, which reveals nothing about the install.
 */
const AVATAR_URL =
  'https://raw.githubusercontent.com/connorgallopo/Tracearr/main/apps/web/public/web-app-manifest-192x192-transparent.png';
const USERNAME = 'Tracearr';
/** Discord refuses a webhook username longer than this. */
const USERNAME_MAX = 80;

/**
 * The name and picture the messages are posted under: DISCORD_USERNAME and
 * DISCORD_AVATAR_URL, else Tracearr's own. The picture must be a public https URL
 * Discord can fetch, with no credentials; anything else is ignored with a warning.
 * Set to an empty value, either one is left out of the message, so the webhook's own
 * name or picture (set in Discord) shows: one place to change them.
 */
export function discordSender(): { username?: string; avatarUrl?: string } {
  const name = process.env.DISCORD_USERNAME?.trim();
  const avatar = process.env.DISCORD_AVATAR_URL?.trim();
  return {
    ...(name !== '' && {
      username: name ? [...name].slice(0, USERNAME_MAX).join('') : USERNAME,
    }),
    ...(avatar !== '' && { avatarUrl: senderAvatar() }),
  };
}

// The refused DISCORD_AVATAR_URL last warned about, so a bad value warns once, not per message.
let warnedAvatar: string | null = null;

function senderAvatar(): string {
  const avatar = (process.env.DISCORD_AVATAR_URL ?? '').trim();
  if (!avatar) return AVATAR_URL;
  if (isPublicHttpsUrl(avatar)) return avatar;
  if (warnedAvatar !== avatar) {
    warnedAvatar = avatar;
    console.warn(
      '[Discord] Ignoring DISCORD_AVATAR_URL: it is not an https URL without credentials'
    );
  }
  return AVATAR_URL;
}

/** An https URL with a host and no credentials: something Discord itself can fetch. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
}

/** Query parameters that could carry a credential, which must never reach Discord. */
const SECRET_PARAM = /token|key|auth|sig|secret|pass/i;

/**
 * A viewer's picture Discord may fetch itself: a public https URL (a Plex account's
 * plex.tv avatar, say). Anything that could name the media server or the user's own
 * network (a relative path, an IP literal, a single-label or local host) or carry a
 * credential is refused, and the message goes without it.
 */
export function publicPictureUrl(value: string | null | undefined): string | null {
  if (!value || !isPublicHttpsUrl(value)) return null;
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    !host.includes('.') ||
    host.startsWith('[') ||
    /^[\d.]+$/.test(host) ||
    /\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(host)
  ) {
    return null;
  }
  for (const name of url.searchParams.keys()) {
    if (SECRET_PARAM.test(name)) return null;
  }
  return value;
}

/** The author line of a stream card: it always names the viewer, with their picture when allowed. */
function viewerLine(text: string, thumbUrl: string | null | undefined): DiscordEmbed['author'] {
  const icon = publicPictureUrl(thumbUrl);
  return icon ? { name: text, icon_url: icon } : { name: text };
}

/** The viewer as the embed's author, with their picture when it is one Discord may fetch. */
function viewerAuthor(
  name: string,
  thumbUrl: string | null | undefined
): Pick<DiscordEmbed, 'author'> {
  const icon = publicPictureUrl(thumbUrl);
  return icon ? { author: { name, icon_url: icon } } : {};
}

/** Discord picks the renderer off the extension, so the name has to match the bytes. */
const POSTER_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function posterFilename(contentType: string): string {
  const base = contentType.split(';')[0]?.trim() ?? '';
  return `poster.${POSTER_EXTENSIONS[base] ?? 'jpg'}`;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  author?: { name: string; icon_url?: string };
  fields?: DiscordField[];
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

/** The embed, plus the poster bytes it references when one was available. */
export interface DiscordMessage {
  embed: DiscordEmbed;
  poster?: { data: Buffer; contentType: string };
}

function buildViolationEmbed(payload: NotificationPayload, ctx: ViolationContext): DiscordEmbed {
  const { violation } = ctx;
  const { label: severityLabel, color } = getSeverityInfo(violation.severity);
  const detailFields = formatViolationDetailsForDiscord(
    violation.rule.type,
    violation.data,
    violation.userNames
  );

  const text = textOf(payload, { title: payload.title, message: '' });

  const userName = violation.user.identityName ?? violation.user.username;

  return {
    ...viewerAuthor(userName, violation.user.thumbUrl),
    title: text.title,
    ...(text.message && { description: text.message }),
    color,
    fields: [
      {
        name: 'User',
        value: userName,
        inline: true,
      },
      {
        name: 'Rule',
        value: violation.rule.name,
        inline: true,
      },
      {
        name: 'Severity',
        value: severityLabel,
        inline: true,
      },
      ...detailFields,
    ],
  };
}

function buildSessionStartedEmbed(payload: NotificationPayload, ctx: SessionContext): DiscordEmbed {
  const { session } = ctx;
  const { title: mediaTitle, subtitle, subtitleLabel } = getMediaDisplay(session);
  const playbackType = getPlaybackType(session);

  const fields: DiscordField[] = [
    {
      name: 'User',
      value: getUserDisplayName(session),
      inline: true,
    },
    {
      name: 'Media',
      value: mediaTitle,
      inline: true,
    },
  ];

  if (subtitle) {
    fields.push({ name: subtitleLabel, value: subtitle, inline: true });
  }

  fields.push({ name: 'Playback', value: playbackType, inline: true });

  const location = isPlacedLocal({ isLocal: session.isLocal, country: session.geoCountry })
    ? `${[session.geoCity, session.geoCountry].filter(Boolean).join(', ')} (${LOCAL_NETWORK_COUNTRY})`
    : session.geoCity && session.geoCountry
      ? `${session.geoCity}, ${session.geoCountry}`
      : null;
  if (location) {
    fields.push({ name: 'Location', value: location, inline: true });
  }

  fields.push({
    name: 'Player',
    value: session.product || session.playerName || 'Unknown',
    inline: true,
  });

  const text = textOf(payload, { title: 'Stream Started', message: '' });

  return {
    ...viewerAuthor(getUserDisplayName(session), session.user.thumbUrl),
    title: text.title,
    ...(text.message && { description: text.message }),
    color: 0x3498db, // Blue
    fields,
  };
}

function buildSessionStoppedEmbed(payload: NotificationPayload, ctx: SessionContext): DiscordEmbed {
  const { session } = ctx;
  const { title: mediaTitle, subtitle, subtitleLabel } = getMediaDisplay(session);
  const durationStr = session.durationMs ? formatDuration(session.durationMs) : 'Unknown';

  const fields: DiscordField[] = [
    {
      name: 'User',
      value: getUserDisplayName(session),
      inline: true,
    },
    {
      name: 'Media',
      value: mediaTitle,
      inline: true,
    },
  ];

  if (subtitle) {
    fields.push({ name: subtitleLabel, value: subtitle, inline: true });
  }

  fields.push({ name: 'Duration', value: durationStr, inline: true });

  const text = textOf(payload, { title: 'Stream Ended', message: '' });

  return {
    ...viewerAuthor(getUserDisplayName(session), session.user.thumbUrl),
    title: text.title,
    ...(text.message && { description: text.message }),
    color: 0x95a5a6, // Gray
    fields,
  };
}

// ---------------------------------------------------------------------------
// Stream cards: a TV episode, a movie and a Live TV channel each get their own
// card. Other media (music, clips, photos) keep the field layout above.
// ---------------------------------------------------------------------------

type StreamKind = 'episode' | 'movie' | 'live';

function streamKind(session: SessionContext['session']): StreamKind | null {
  switch (session.mediaType) {
    case 'episode':
    case 'movie':
    case 'live':
      return session.mediaType;
    default:
      return null;
  }
}

const STREAM_COLORS: Record<StreamKind, number> = {
  episode: 0x3498db, // Blue
  movie: 0xf1c40f, // Gold
  live: 0xe74c3c, // Red
};
const STREAM_ENDED_COLOR = 0x95a5a6; // Gray

/** What a card needs beyond the session: Live TV's channel from the guide, a movie's genres. */
interface StreamExtras {
  airing?: LiveTvAiring | null;
  genres?: string[];
}

/** "S4 E17", unpadded as a guide or a TV shows it; null without both numbers. */
function seasonEpisode(season: number | null, episode: number | null): string | null {
  return season === null || episode === null ? null : `S${season} E${episode}`;
}

/** A runtime as "1h 33m", "45m" or "2h". */
export function formatRuntime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** A start time as "3:30 PM" in Tracearr's time zone (TZ), the one its schedules use. */
export function formatClock(epochMs: number): string {
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  let text: string;
  try {
    text = new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: process.env.TZ || undefined,
    }).format(epochMs);
  } catch {
    // An unknown TZ name: the process's own zone.
    text = new Intl.DateTimeFormat('en-US', options).format(epochMs);
  }
  return text.replace(/\s/g, ' ');
}

/**
 * Where the viewer is, for the one-line summary: the city, or the existing rules' answer
 * when they place a local session ("Chicago (Local Network)"); nothing when they show none.
 */
function compactLocation(session: SessionContext['session']): string | null {
  if (isPlacedLocal({ isLocal: session.isLocal, country: session.geoCountry })) {
    const place = session.geoCity || session.geoCountry;
    return place ? `${place} (${LOCAL_NETWORK_COUNTRY})` : LOCAL_NETWORK_COUNTRY;
  }
  return session.geoCity && session.geoCountry ? session.geoCity : null;
}

/** "Plex for Apple TV · Direct Play · Bentonville". */
function watchLine(session: SessionContext['session']): string {
  return [
    session.product || session.playerName || 'Unknown',
    getPlaybackType(session),
    compactLocation(session),
  ]
    .filter((part): part is string => !!part)
    .map(escapeDiscordMarkdown)
    .join(' · ');
}

/** "S4 E17 · Best Men", or the title alone. */
function episodeLine(session: SessionContext['session']): string {
  const label = seasonEpisode(session.seasonNumber, session.episodeNumber);
  const title = escapeDiscordMarkdown(session.mediaTitle);
  return label ? `${label} · ${title}` : title;
}

/** The programme in one line: "Modern Family · S4 E17 Best Men", or "Little Big Man (1970)". */
function programmeLine(session: SessionContext['session']): string {
  if (session.grandparentTitle) {
    const label = seasonEpisode(session.seasonNumber, session.episodeNumber);
    const episode = [label, escapeDiscordMarkdown(session.mediaTitle)]
      .filter((part): part is string => !!part)
      .join(' ');
    return `${escapeDiscordMarkdown(session.grandparentTitle)} · ${episode}`;
  }
  return escapeDiscordMarkdown(
    session.year ? `${session.mediaTitle} (${session.year})` : session.mediaTitle
  );
}

function nextLine(next: PlexGuideAiring): string {
  return `Next: ${escapeDiscordMarkdown(next.showTitle ?? next.title)} at ${formatClock(next.beginsAt)}`;
}

interface CardChannel {
  number: string | null;
  name: string | null;
  thumb: string | null;
}

/** A channel number a viewer would recognise ("5", "5.1"), not an internal key. */
const CHANNEL_NUMBER = /^\d{1,5}([.-]\d{1,3})?$/;

/**
 * The session's channel: the guide's when it found one, else what the session itself
 * carries (Jellyfin and Emby name it, and Plex for some guides).
 */
function cardChannel(
  session: SessionContext['session'],
  airing: LiveTvAiring | null | undefined
): CardChannel | null {
  if (airing) {
    const { number, title, callSign, thumb } = airing.channel;
    const titleName =
      title && number && title.startsWith(`${number} `) ? title.slice(number.length + 1) : title;
    const name = callSign || titleName;
    return { number, name: name === number ? null : name, thumb };
  }
  if (!session.channelTitle) return null;
  const number =
    session.channelIdentifier && CHANNEL_NUMBER.test(session.channelIdentifier)
      ? session.channelIdentifier
      : null;
  return { number, name: session.channelTitle, thumb: null };
}

function channelHeading(channel: CardChannel | null): string | null {
  if (!channel) return null;
  if (channel.number && channel.name) return `Channel ${channel.number} · ${channel.name}`;
  if (channel.name) return channel.name;
  return channel.number ? `Channel ${channel.number}` : null;
}

/**
 * A stream's card. Started: who is watching, the show or film or channel as the title, what
 * it is underneath, and the player, playback and place in one line. Ended: the same title
 * and the watch time. An automation's own title or body still wins.
 */
function buildStreamCard(
  payload: NotificationPayload,
  ctx: SessionContext,
  kind: StreamKind,
  extras: StreamExtras
): DiscordEmbed {
  const { session } = ctx;
  const started = ctx.type === 'stream_started';
  const viewer = getUserDisplayName(session);
  const lines: string[] = [];
  let title: string;
  let author: string;

  switch (kind) {
    case 'episode':
      author = started ? `${viewer} is watching` : `${viewer} stopped watching`;
      title = session.grandparentTitle || session.mediaTitle;
      lines.push(session.grandparentTitle ? episodeLine(session) : '');
      break;
    case 'movie': {
      author = started ? `${viewer} is watching` : `${viewer} stopped watching`;
      title = session.year ? `${session.mediaTitle} (${session.year})` : session.mediaTitle;
      const about = [
        ...(extras.genres ?? []).slice(0, 3),
        ...(session.totalDurationMs ? [formatRuntime(session.totalDurationMs)] : []),
      ];
      lines.push(about.map(escapeDiscordMarkdown).join(' · '));
      break;
    }
    case 'live': {
      author = started ? `${viewer} tuned in` : `${viewer} tuned out`;
      const heading = channelHeading(cardChannel(session, extras.airing));
      if (heading) {
        title = heading;
        lines.push(`${started ? 'Now' : 'Was on'}: ${programmeLine(session)}`);
        const next = extras.airing?.next;
        if (started && next) lines.push(nextLine(next));
      } else {
        title = session.grandparentTitle || session.mediaTitle;
        const what = session.grandparentTitle
          ? episodeLine(session)
          : session.year
            ? String(session.year)
            : null;
        lines.push(what ? `Live TV · ${what}` : 'Live TV');
      }
      break;
    }
  }

  if (started) {
    lines.push(watchLine(session));
  } else if (session.durationMs) {
    lines.push(`Watched for ${formatDuration(session.durationMs)}`);
  }

  const text = textOf(payload, {
    title,
    message: lines.filter((line) => line !== '').join('\n'),
  });

  return {
    author: viewerLine(author, session.user.thumbUrl),
    title: text.title,
    ...(text.message && { description: text.message }),
    color: started ? STREAM_COLORS[kind] : STREAM_ENDED_COLOR,
  };
}

/** The moment to find a Live TV programme in the guide: when it started, or just before it stopped. */
function liveLookupTime(ctx: SessionContext): Date {
  const { session } = ctx;
  if (ctx.type === 'stream_started') return new Date(session.startedAt);
  const stopped = session.stoppedAt ? new Date(session.stoppedAt).getTime() : Date.now();
  return new Date(stopped - 60_000);
}

async function streamExtras(ctx: SessionContext, kind: StreamKind): Promise<StreamExtras> {
  const { session } = ctx;
  if (kind === 'movie') {
    return { genres: await itemGenres(session.serverId, session.ratingKey, session.mediaId) };
  }
  if (kind === 'live' && session.server.type === 'plex') {
    const airing = await liveTvGuide
      .findAiring(session, liveLookupTime(ctx), { next: ctx.type === 'stream_started' })
      .catch(() => null);
    return { airing };
  }
  return {};
}

function buildServerDownEmbed(payload: NotificationPayload, ctx: ServerContext): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Server Connection Lost',
    message: `Lost connection to ${ctx.serverName}`,
  });
  return { title: text.title, description: text.message, color: 0xff0000 }; // Red
}

function buildServerUpEmbed(payload: NotificationPayload, ctx: ServerContext): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Server Back Online',
    message: `${ctx.serverName} is back online`,
  });
  return { title: text.title, description: text.message, color: 0x2ecc71 }; // Green
}

function buildPluginUpdateEmbed(
  payload: NotificationPayload,
  ctx: PluginUpdateContext
): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Plugin Update Available',
    message: `${ctx.serverName}: ${formatPluginUpdateMessage(ctx)}`,
  });
  return { title: text.title, description: text.message, color: 0xf39c12 }; // Orange/Warning
}

function buildServerUpdateEmbed(
  payload: NotificationPayload,
  ctx: ServerUpdateContext
): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Server Update Available',
    message: formatServerUpdateMessage(ctx),
  });
  return { title: text.title, description: text.message, color: 0xf39c12 }; // Orange/Warning
}

function buildTracearrUpdateEmbed(
  payload: NotificationPayload,
  ctx: TracearrUpdateContext
): DiscordEmbed {
  const text = textOf(payload, {
    title: 'Tracearr Update Available',
    message: formatTracearrUpdateMessage(ctx),
  });
  return { title: text.title, description: text.message, color: 0x3498db }; // Blue
}

/** Fields a media embed always carries; the year only when the item has one. */
function mediaFields(ctx: MediaAddedContext | MediaUpgradedContext): DiscordField[] {
  const fields: DiscordField[] = [
    { name: 'Library', value: ctx.libraryName, inline: true },
    { name: 'Server', value: ctx.serverName, inline: true },
  ];
  if (ctx.year !== null) {
    fields.push({ name: 'Year', value: String(ctx.year), inline: true });
  }
  return fields;
}

function linkField(links: { label: string; url: string }[]): DiscordField[] {
  if (links.length === 0) return [];
  return [
    {
      name: 'View details',
      value: links.map((l) => `[${l.label}](${l.url})`).join('  ·  '),
      inline: false,
    },
  ];
}

/**
 * A season says how many episodes came with it, an episode says which episode it is, and
 * everything else says it arrived. The parent is in the title, so the description carries
 * the item's own name.
 */
function buildMediaAddedEmbed(
  payload: NotificationPayload,
  ctx: MediaAddedContext,
  links: { label: string; url: string }[]
): DiscordEmbed {
  const subtitle = mediaSubtitle(ctx);
  const count =
    ctx.addedEpisodeCount === undefined || ctx.addedEpisodeCount === 0
      ? null
      : `${String(ctx.addedEpisodeCount)} ${ctx.addedEpisodeCount === 1 ? 'episode' : 'episodes'} added`;
  const lines = [subtitle === null ? null : `**${subtitle}**`, count].filter(
    (line): line is string => line !== null
  );

  const text = textOf(payload, { title: mediaHeadline(ctx), message: lines.join('\n') });

  return {
    author: { name: payload.automation?.name ?? 'New media added' },
    title: text.title,
    ...(text.message && { description: text.message }),
    ...(links[0] && { url: links[0].url }),
    color: 0x1abc9c, // Teal
    fields: [...mediaFields(ctx), ...linkField(links)],
    footer: { text: 'Tracearr' },
  };
}

/** One field per quality field that moved, so the whole improvement is visible at a glance. */
function buildMediaUpgradedEmbed(
  payload: NotificationPayload,
  ctx: MediaUpgradedContext,
  links: { label: string; url: string }[]
): DiscordEmbed {
  const subtitle = mediaSubtitle(ctx);
  const text = textOf(payload, {
    title: mediaHeadline(ctx),
    message: subtitle === null ? '' : `**${subtitle}**`,
  });

  const moves = qualityMoves(ctx).map((move) => ({
    name: move.label,
    value: move.move,
    inline: true,
  }));

  return {
    author: { name: payload.automation?.name ?? 'Media upgraded' },
    title: text.title,
    ...(text.message && { description: text.message }),
    ...(links[0] && { url: links[0].url }),
    color: 0x16a085, // Darker teal - a library event like media added, not the trust purple
    fields: [...moves, ...mediaFields(ctx), ...linkField(links)],
    footer: { text: 'Tracearr' },
  };
}

/** The events whose whole text the payload already carries; the colour is all that differs. */
function buildOwnText(payload: NotificationPayload, color: number): DiscordEmbed {
  const text = ownText(payload);
  return { title: text.title, description: text.message, color };
}

/**
 * The poster, as bytes. A miss degrades to no thumbnail rather than failing the send -
 * proxyImage answers an unreachable server with an SVG placeholder, which Discord will
 * not render, so only a raster image is worth uploading.
 */
async function fetchPoster(
  serverId: string,
  thumbPath: string | null
): Promise<{ data: Buffer; contentType: string } | undefined> {
  if (thumbPath === null || thumbPath === '') return undefined;
  try {
    const result = await proxyImage({
      serverId,
      imagePath: thumbPath,
      ...POSTER_IMAGE_SIZE,
      fallback: 'poster',
    });
    if (!result.contentType.startsWith('image/') || result.contentType.includes('svg')) {
      return undefined;
    }
    return { data: result.data, contentType: result.contentType };
  } catch {
    return undefined;
  }
}

async function buildMediaMessage(
  payload: NotificationPayload,
  ctx: MediaAddedContext | MediaUpgradedContext
): Promise<DiscordMessage> {
  const [links, poster] = await Promise.all([
    buildMediaLinks(ctx).catch(() => []),
    fetchPoster(ctx.serverId, ctx.thumbPath),
  ]);
  const embed =
    ctx.type === 'media_added'
      ? buildMediaAddedEmbed(payload, ctx, links)
      : buildMediaUpgradedEmbed(payload, ctx, links);
  return withPoster(embed, poster);
}

/**
 * A stream shows the poster its Now Playing card does: the session's thumb, which for a
 * Live TV episode with no picture of its own is already the channel logo or the show's
 * poster. An outside URL there is fetched only as the image proxy allows
 * (EXTERNAL_IMAGE_ORIGINS, through the media server).
 */
async function buildSessionMessage(
  payload: NotificationPayload,
  ctx: SessionContext
): Promise<DiscordMessage> {
  const { session } = ctx;
  const kind = streamKind(session);
  if (kind === null) {
    const poster = await fetchPoster(session.serverId, session.thumbPath);
    return withPoster(buildEmbed(payload), poster);
  }

  const extras = await streamExtras(ctx, kind);
  // A Live TV channel shows its logo from the guide; without one, the session's own picture.
  const logo = extras.airing?.channel.thumb ?? null;
  const poster =
    (logo !== null ? await fetchPoster(session.serverId, logo) : undefined) ??
    (await fetchPoster(session.serverId, session.thumbPath));
  return withPoster(buildStreamCard(payload, ctx, kind, extras), poster);
}

function withPoster(
  embed: DiscordEmbed,
  poster: { data: Buffer; contentType: string } | undefined
): DiscordMessage {
  if (!poster) return { embed };
  const filename = posterFilename(poster.contentType);
  return { embed: { ...embed, thumbnail: { url: `attachment://${filename}` } }, poster };
}

function embedChars(embed: DiscordEmbed): number {
  const fields = (embed.fields ?? []).reduce(
    (sum, field) => sum + [...field.name].length + [...field.value].length,
    0
  );
  return (
    [...embed.title].length +
    [...(embed.description ?? '')].length +
    fields +
    [...(embed.footer?.text ?? '')].length +
    [...(embed.author?.name ?? '')].length
  );
}

/** Discord rejects an embed over its limits rather than cutting it, so the text is cut here. */
export function fitEmbed(embed: DiscordEmbed): DiscordEmbed {
  const { description, ...rest } = embed;
  const title = PROFILE.title ? fitText(embed.title, PROFILE.title) : embed.title;
  let body = description && PROFILE.body ? fitText(description, PROFILE.body) : description;
  const fitted: DiscordEmbed = { ...rest, title };
  if (body) {
    const room = EMBED_TOTAL - embedChars(fitted);
    body = room > 1 ? fitText(body, { max: room, unit: 'chars' }) : undefined;
  }
  return body ? { ...fitted, description: body } : fitted;
}

/**
 * Media events fetch a poster and their links, streams their poster; everything else
 * renders from the payload alone.
 */
async function buildMessage(payload: NotificationPayload): Promise<DiscordMessage> {
  const { context } = payload;
  const message =
    context.type === 'media_added' || context.type === 'media_upgraded'
      ? await buildMediaMessage(payload, context)
      : context.type === 'stream_started' || context.type === 'stream_stopped'
        ? await buildSessionMessage(payload, context)
        : { embed: buildEmbed(payload) };
  return { ...message, embed: fitEmbed(message.embed) };
}

function buildEmbed(payload: NotificationPayload): DiscordEmbed {
  switch (payload.context.type) {
    case 'violation_detected':
      return buildViolationEmbed(payload, payload.context);
    case 'stream_started':
      return buildSessionStartedEmbed(payload, payload.context);
    case 'stream_stopped':
      return buildSessionStoppedEmbed(payload, payload.context);
    case 'server_down':
      return buildServerDownEmbed(payload, payload.context);
    case 'server_up':
      return buildServerUpEmbed(payload, payload.context);
    case 'plugin_update_available':
      return buildPluginUpdateEmbed(payload, payload.context);
    case 'server_update_available':
      return buildServerUpdateEmbed(payload, payload.context);
    case 'tracearr_update_available':
      return buildTracearrUpdateEmbed(payload, payload.context);
    case 'media_added':
      return buildMediaAddedEmbed(payload, payload.context, []);
    case 'media_upgraded':
      return buildMediaUpgradedEmbed(payload, payload.context, []);
    case 'new_device':
      return buildOwnText(payload, 0xf39c12); // Orange/Warning
    case 'trust_score_changed':
      return buildOwnText(payload, 0x9b59b6); // Purple
    case 'newsletter_send':
      return buildOwnText(payload, payload.context.outcome === 'sent' ? 0x2ecc71 : 0xe74c3c);
  }
}

/**
 * A poster rides along as multipart, which is the only way to get an image into an embed
 * without a URL Discord can reach. Content-Type is left unset on purpose so undici writes
 * the multipart boundary itself.
 */
async function post(
  webhookUrl: string,
  message: DiscordMessage,
  ctx: DeliverContext
): Promise<void> {
  const filename = message.poster && posterFilename(message.poster.contentType);
  const sender = discordSender();
  const payload = {
    ...(sender.username !== undefined && { username: sender.username }),
    ...(sender.avatarUrl !== undefined && { avatar_url: sender.avatarUrl }),
    allowed_mentions: { parse: [] },
    embeds: [{ ...message.embed, timestamp: new Date().toISOString() }],
    ...(filename && { attachments: [{ id: 0, filename }] }),
  };

  if (!message.poster) {
    await deliverFetch(
      webhookUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      ctx
    );
    return;
  }

  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append(
    'files[0]',
    new Blob([new Uint8Array(message.poster.data)], { type: message.poster.contentType }),
    filename ?? 'poster.jpg'
  );
  await deliverFetch(webhookUrl, { method: 'POST', body: form }, ctx);
}

export const discordType: DestinationType<DiscordConfig, DiscordMessage> = {
  kind: 'discord',
  events: DESTINATION_TYPES.discord.events,
  render: (event, _config, ctx) =>
    buildMessage(toNotificationPayload(event, ctx.source, escapeFor(PROFILE))),
  deliver: (message, config, ctx) => post(config.webhookUrl, message, ctx),
  test: (config, ctx) =>
    post(
      config.webhookUrl,
      {
        embed: {
          title: 'Test Notification',
          description: 'This is a test notification from Tracearr',
          color: 0x3498db,
        },
      },
      ctx
    ),
};
