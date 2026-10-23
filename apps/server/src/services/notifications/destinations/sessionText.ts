import { formatEpisodeLabel, type PlaybackDecision, playbackDecision } from '@tracearr/shared';
import type { ActiveSession } from '../types.js';

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/** Get display title for media (matches UI card logic) */
/**
 * The media line of a session message: the show and its episode, or the title and its year. `subtitleLabel` names
 * what `subtitle` is, so a movie's year isn't labelled "Episode". A Live TV programme that carries its show (an
 * XMLTV guide episode, e.g. from Tunarr) reads like an episode.
 */
export function getMediaDisplay(session: ActiveSession): {
  title: string;
  subtitle: string | null;
  subtitleLabel: 'Episode' | 'Year';
} {
  if (
    (session.mediaType === 'episode' || session.mediaType === 'live') &&
    session.grandparentTitle
  ) {
    const episodeInfo =
      formatEpisodeLabel(session.seasonNumber, session.episodeNumber, { spaced: true }) ?? '';
    return {
      title: session.grandparentTitle,
      subtitle: episodeInfo ? `${episodeInfo} · ${session.mediaTitle}` : session.mediaTitle,
      subtitleLabel: 'Episode',
    };
  }
  return {
    title: session.mediaTitle,
    subtitle: session.year ? `${session.year}` : null,
    subtitleLabel: 'Year',
  };
}

const PLAYBACK_TYPE_LABELS: Record<PlaybackDecision, string> = {
  directplay: 'Direct Play',
  copy: 'Direct Stream',
  audio_transcode: 'Audio Transcode',
  transcode: 'Transcode',
};

export function getPlaybackType(session: ActiveSession): string {
  return PLAYBACK_TYPE_LABELS[playbackDecision(session)];
}

export function getUserDisplayName(session: ActiveSession): string {
  return session.user.identityName ?? session.user.username;
}
