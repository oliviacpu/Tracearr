import { describe, expect, it } from 'vitest';
import { getDeviceDisplayName, getLiveChannelLabel, getMediaLinks } from './utils';

describe('getDeviceDisplayName', () => {
  it('prefers the name the client gave itself', () => {
    expect(
      getDeviceDisplayName({
        playerName: "Emily's Fire TV",
        product: 'Plex for Amazon FireTV',
        device: 'AFTMM',
        platform: 'Fire TV',
      })
    ).toBe("Emily's Fire TV");
  });

  it('falls back to the app and the hardware it runs on', () => {
    expect(
      getDeviceDisplayName({ playerName: null, product: 'Plex for Roku', device: '50S425' })
    ).toBe('Plex for Roku - 50S425');
  });

  it('does not repeat hardware the app name already contains', () => {
    expect(getDeviceDisplayName({ playerName: null, product: 'Plex for iOS', device: 'iOS' })).toBe(
      'Plex for iOS'
    );
  });

  it('falls back to the platform, then to nothing at all', () => {
    expect(getDeviceDisplayName({ platform: 'Roku' })).toBe('Roku');
    expect(getDeviceDisplayName({})).toBeNull();
  });
});

describe('getMediaLinks', () => {
  it('links a movie title to its media page', () => {
    expect(getMediaLinks({ mediaType: 'movie', mediaTitle: 'Heat', mediaId: 'm1' })).toEqual({
      title: '/media/m1',
      subtitle: null,
    });
  });

  it('links an episode show name to the show and the episode line to the episode', () => {
    expect(
      getMediaLinks({
        mediaType: 'episode',
        mediaTitle: 'Pilot',
        grandparentTitle: 'Lost',
        mediaId: 'ep1',
        showMediaId: 'show1',
      })
    ).toEqual({ title: '/media/show1', subtitle: '/media/ep1' });
  });

  it('links nothing when the ids are missing', () => {
    expect(
      getMediaLinks({
        mediaType: 'episode',
        mediaTitle: 'Pilot',
        grandparentTitle: 'Lost',
        mediaId: null,
        showMediaId: null,
      })
    ).toEqual({ title: null, subtitle: null });
  });
});

describe('getLiveChannelLabel', () => {
  const live = { mediaType: 'live', channelTitle: 'Sitcoms', channelIdentifier: '3' };

  it('names the channel by number and name', () => {
    expect(getLiveChannelLabel(live)).toBe('Channel 3 · Sitcoms');
    expect(getLiveChannelLabel({ ...live, channelIdentifier: '5.1' })).toBe(
      'Channel 5.1 · Sitcoms'
    );
  });

  it('leaves out an identifier that is not a channel number', () => {
    expect(getLiveChannelLabel({ ...live, channelIdentifier: 'C3.51.tunarr.com' })).toBe('Sitcoms');
    expect(getLiveChannelLabel({ ...live, channelIdentifier: null })).toBe('Sitcoms');
  });

  it('gives the number alone when the name is only the number', () => {
    expect(getLiveChannelLabel({ ...live, channelTitle: '3' })).toBe('Channel 3');
  });

  it('is null without a channel and for anything but Live TV', () => {
    expect(getLiveChannelLabel({ mediaType: 'live', channelTitle: null })).toBeNull();
    expect(getLiveChannelLabel({ ...live, mediaType: 'episode' })).toBeNull();
  });
});
