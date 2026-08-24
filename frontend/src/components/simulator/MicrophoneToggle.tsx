/**
 * Microphone button rendered on the canvas header for boards whose def
 * declares builtInMicrophone (XIAO ESP32S3 Sense, M5Stack Cardputer ADV).
 *
 * Click -> asks for mic permission -> streams the computer's microphone into
 * the board's emulated PDM/I2S mic through the bridge's setMicrophoneSource
 * seam. While off, the bridge feeds its built-in 440 Hz test tone, so unlike
 * the camera there is NO auto-start on run: sketches read a live level either
 * way, and grabbing the user's microphone should take an explicit click.
 *
 * Visual states mirror CameraToggle:
 *   idle       grey mic icon
 *   requesting orange (pulsing) — browser permission prompt visible
 *   streaming  green + live level meter
 *   denied     red, click-to-retry
 *   error      red, hover for message
 */
import React from 'react';
import { useMicrophoneStream } from '../../hooks/useMicrophoneStream';

interface MicrophoneToggleProps {
  boardId: string | null;
}

export const MicrophoneToggle: React.FC<MicrophoneToggleProps> = ({ boardId }) => {
  const { status, errorMessage, level, start, stop } = useMicrophoneStream();

  const handleClick = () => {
    if (!boardId) return;
    if (status === 'streaming') {
      stop();
    } else {
      void start(boardId);
    }
  };

  const isOn = status === 'streaming';
  const pct = Math.round(level * 100);

  const tooltip =
    status === 'streaming'
      ? `Streaming your microphone (level ${pct}%) — click to stop (falls back to the test tone)`
      : status === 'requesting'
        ? 'Asking for microphone permission…'
        : status === 'denied'
          ? 'Permission denied. Click to retry.'
          : status === 'error'
            ? `Microphone error: ${errorMessage ?? 'unknown'}`
            : 'Use your microphone as the board mic (off = 440 Hz test tone)';

  const color =
    status === 'streaming'
      ? '#3fb950'
      : status === 'requesting'
        ? '#f0883e'
        : status === 'denied' || status === 'error'
          ? '#f85149'
          : '#ccc';

  return (
    <button
      onClick={handleClick}
      disabled={!boardId || status === 'requesting'}
      title={tooltip}
      // Static layout is in .canvas-cam-mic-btn so the toolbar @container
      // query can collapse the label to icon-only (an inline font-size would
      // beat it). Only state-driven styles stay inline.
      className="canvas-cam-mic-btn"
      style={{
        backgroundColor: isOn ? 'rgba(63,185,80,0.15)' : 'transparent',
        border: `1px solid ${
          isOn ? '#3fb950' : status === 'requesting' ? '#555' : 'transparent'
        }`,
        color,
        cursor: boardId ? 'pointer' : 'not-allowed',
        animation:
          status === 'requesting' ? 'velxio-pulse 1s ease-in-out infinite' : undefined,
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
      <span>{isOn ? `Mic ${pct}%` : 'Mic'}</span>
    </button>
  );
};
