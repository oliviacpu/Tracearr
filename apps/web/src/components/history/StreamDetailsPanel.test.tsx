import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { StreamDetailsPanel } from './StreamDetailsPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type Props = ComponentProps<typeof StreamDetailsPanel>;

// A Plex Live TV transcode from a Tunarr channel, as Tracearr records it.
const liveTranscode: Props = {
  sourceVideoCodec: 'h264',
  sourceAudioCodec: 'ac3',
  sourceAudioChannels: 6,
  sourceVideoWidth: 1920,
  sourceVideoHeight: 1080,
  streamVideoCodec: 'h264',
  streamAudioCodec: 'ac3',
  sourceVideoDetails: null,
  sourceAudioDetails: null,
  streamVideoDetails: { bitrate: 20121, width: 1920, height: 1080 },
  streamAudioDetails: { bitrate: 640, channels: 6 },
  transcodeInfo: { speed: 0.8, maxOffsetAvailable: 356 },
  subtitleInfo: null,
  videoDecision: 'transcode',
  audioDecision: 'copy',
  bitrate: 20761,
  serverType: 'plex',
  mediaType: 'live',
};

function renderPanel(overrides: Partial<Props> = {}) {
  render(
    <TooltipProvider>
      <StreamDetailsPanel {...liveTranscode} {...overrides} />
    </TooltipProvider>
  );
}

function openTranscodeDetails() {
  fireEvent.click(screen.getByText('Transcode Details'));
}

describe('StreamDetailsPanel Live TV speed', () => {
  it('says the transcode keeps up instead of showing Plex’s instantaneous speed', () => {
    renderPanel({
      transcodeInfo: { speed: 0.8, livePace: 'keeping_up', livePaceRate: 0.98 },
    });
    openTranscodeDetails();

    expect(screen.getByTestId('live-pace')).toHaveTextContent('Keeping up');
    expect(screen.queryByText('0.8x')).not.toBeInTheDocument();
  });

  it('marks a transcode that falls behind', () => {
    renderPanel({
      transcodeInfo: { speed: 0.7, livePace: 'falling_behind', livePaceRate: 0.7 },
    });
    openTranscodeDetails();

    const row = screen.getByTestId('live-pace');
    expect(row).toHaveTextContent('Falling behind');
    expect(row.querySelector('.text-amber-500')).not.toBeNull();
  });

  it('keeps Plex’s speed until the pace is measured, and for everything else', () => {
    renderPanel({ transcodeInfo: { speed: 0.8 } });
    openTranscodeDetails();

    expect(screen.queryByTestId('live-pace')).toBeNull();
    expect(screen.getByText('0.8x')).toBeInTheDocument();
  });
});

describe('StreamDetailsPanel Live TV bitrate', () => {
  it('shows Plex’s figures for a Live TV video transcode as its maximum', () => {
    renderPanel();

    const caps = screen.getAllByTestId('max-bitrate').map((el) => el.textContent);
    // The overall rate (20,121k video cap plus 640k audio) and the video cap.
    expect(caps).toEqual(['max 20.8 Mbps', 'max 20.1 Mbps']);
  });

  it('says a live source has no known bitrate rather than leaving it blank', () => {
    renderPanel();

    // The video and audio sources; the audio stream has Plex's 640 kbps.
    expect(screen.getAllByText('Live, unknown')).toHaveLength(2);
    expect(screen.getByText('640 kbps')).toBeInTheDocument();
  });

  it('keeps a measured live bitrate as it is', () => {
    renderPanel({ sourceAudioDetails: { bitrate: 640 }, streamAudioDetails: { channels: 6 } });

    expect(screen.getAllByText('640 kbps')).toHaveLength(2);
    expect(screen.getAllByText('Live, unknown')).toHaveLength(1);
  });

  it('leaves the figures plain without a video transcode, and for other media', () => {
    renderPanel({ videoDecision: 'copy' });
    expect(screen.queryByTestId('max-bitrate')).toBeNull();
    expect(screen.getByText('20.8 Mbps')).toBeInTheDocument();
  });

  it('leaves a film’s transcode and its missing figures as upstream shows them', () => {
    renderPanel({ mediaType: 'movie' });
    expect(screen.queryByTestId('max-bitrate')).toBeNull();
    expect(screen.queryByText('Live, unknown')).toBeNull();
    expect(screen.getByText('20.8 Mbps')).toBeInTheDocument();
  });
});
