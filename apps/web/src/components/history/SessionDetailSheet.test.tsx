import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { SessionWithDetails } from '@tracearr/shared';
import { SessionDetailSheet } from './SessionDetailSheet';

const auth = vi.hoisted(() => ({ user: { role: 'owner' } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderSheet(overrides: Partial<SessionWithDetails>, onOpenChange = vi.fn()) {
  const session = {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'su-1',
    server: { id: 'server-1', name: 'Jelly', type: 'jellyfin' },
    user: { id: 'su-1', username: 'alice', thumbUrl: null, identityName: null },
    state: 'stopped',
    mediaType: 'movie',
    mediaTitle: 'Heat',
    startedAt: new Date('2024-01-01T20:00:00Z'),
    stoppedAt: new Date('2024-01-01T21:00:00Z'),
    durationMs: 3_600_000,
    progressMs: null,
    totalDurationMs: null,
    geoLat: null,
    geoLon: null,
    ...overrides,
  } as unknown as SessionWithDetails;

  return render(
    <MemoryRouter>
      <SessionDetailSheet session={session} open onOpenChange={onOpenChange} />
    </MemoryRouter>
  );
}

describe('SessionDetailSheet', () => {
  it('links the person to their user page for an owner, and shows them unlinked to a member', () => {
    const { unmount } = renderSheet({});
    expect(screen.getByRole('link', { name: /alice/ })).toHaveAttribute('href', '/users/su-1');
    unmount();

    auth.user.role = 'member';
    renderSheet({});
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /alice/ })).toBeNull();
    auth.user.role = 'owner';
  });

  it('shows no progress percentage for a play without a total', () => {
    renderSheet({ progressMs: 3_600_000, totalDurationMs: null });

    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows no progress percentage for a play with a total but no position', () => {
    renderSheet({ progressMs: null, totalDurationMs: 5_400_000 });

    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows 0% for a play whose position is a measured 0', () => {
    renderSheet({ progressMs: 0, totalDurationMs: 5_400_000 });

    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('shows the progress percentage when the play has a total', () => {
    renderSheet({ progressMs: 2_700_000, totalDurationMs: 5_400_000 });

    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('links a movie title to its media page', () => {
    renderSheet({ mediaId: 'movie-1' });

    expect(screen.getByRole('link', { name: 'Heat' })).toHaveAttribute('href', '/media/movie-1');
  });

  it('links the show name to the show and the episode line to the episode', () => {
    renderSheet({
      mediaType: 'episode',
      mediaTitle: 'Pilot',
      grandparentTitle: 'Lost',
      seasonNumber: 1,
      episodeNumber: 2,
      mediaId: 'episode-1',
      showMediaId: 'show-1',
    });

    expect(screen.getByRole('link', { name: 'Lost' })).toHaveAttribute('href', '/media/show-1');
    expect(screen.getByRole('link', { name: /Pilot/ })).toHaveAttribute('href', '/media/episode-1');
  });

  it('leaves the titles as plain text when the ids are missing', () => {
    renderSheet({
      mediaType: 'episode',
      mediaTitle: 'Pilot',
      grandparentTitle: 'Lost',
      mediaId: null,
      showMediaId: null,
    });

    expect(screen.getByText('Lost').closest('a')).toBeNull();
    expect(screen.getByText(/Pilot/).closest('a')).toBeNull();
  });

  it('closes the sheet when a title link is followed', () => {
    const onOpenChange = vi.fn();
    renderSheet({ mediaId: 'movie-1' }, onOpenChange);

    fireEvent.click(screen.getByRole('link', { name: 'Heat' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("names a Live TV session's channel next to its media type", () => {
    renderSheet({
      server: { id: 'server-1', name: 'Basement', type: 'plex' },
      mediaType: 'live',
      mediaTitle: 'Janet(s)',
      channelTitle: 'Sitcoms',
      channelIdentifier: '3',
      channelThumb: 'https://guide.example.com/images/uploads/sitcoms_icon.png?v=1',
    } as Partial<SessionWithDetails>);

    const channel = screen.getByTestId('live-channel');
    expect(channel).toHaveTextContent('Channel 3 · Sitcoms');
    expect(channel.querySelector('img')?.getAttribute('src')).toContain('/api/v1/images/proxy?');
  });

  it('reads a Live TV episode like an episode', () => {
    renderSheet({
      server: { id: 'server-1', name: 'Basement', type: 'plex' },
      mediaType: 'live',
      mediaTitle: 'Janet(s)',
      grandparentTitle: 'The Good Place',
      seasonNumber: 3,
      episodeNumber: 10,
      channelTitle: 'Sitcoms',
      channelIdentifier: '3',
    } as Partial<SessionWithDetails>);

    expect(screen.getByText('The Good Place')).toBeInTheDocument();
    expect(screen.getByText('S03 E10 · Janet(s)')).toBeInTheDocument();
    expect(screen.getByTestId('live-channel')).toHaveTextContent('Channel 3 · Sitcoms');
  });
});
