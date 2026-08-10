/**
 * Header toggles for component-owned webcams (see componentCameraRegistry).
 *
 * One button per registered component camera, drawn like CameraToggle so the
 * header speaks one language: green while the webcam feeds the component,
 * red with the reason in the tooltip when it could not, grey when off.
 * Renders nothing for the common project with no such component.
 */
import React from 'react';
import { useComponentCameras } from '../../lib/componentCameraRegistry';
import type { ComponentCameraEntry } from '../../lib/componentCameraRegistry';

const Toggle: React.FC<{ cam: ComponentCameraEntry }> = ({ cam }) => {
  const isOn = cam.status === 'live';
  const color = isOn ? '#3fb950' : cam.status === 'error' ? '#f85149' : '#ccc';
  const tooltip =
    cam.status === 'live'
      ? `${cam.label}: your webcam is on — click to stop`
      : cam.status === 'error'
        ? `${cam.label}: ${cam.reason ?? 'camera failed'} — click to retry`
        : `${cam.label}: click to use your webcam`;
  return (
    <button
      onClick={cam.toggle}
      title={tooltip}
      style={{
        backgroundColor: isOn ? 'rgba(63,185,80,0.15)' : 'transparent',
        border: `1px solid ${isOn ? '#3fb950' : 'transparent'}`,
        borderRadius: 4,
        padding: '4px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color,
        fontSize: 13,
        cursor: 'pointer',
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
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
      {/* The button says "Camera", exactly like the board CameraToggle —
          one header language (user feedback: "HuskyLens cam" next to the
          ESP32-CAM's plain "Camera" read as a different thing). WHICH
          camera it is stays in the tooltip, where it matters when a board
          camera and a component camera coexist. */}
      <span>Camera</span>
    </button>
  );
};

export const ComponentCameraToggles: React.FC = () => {
  const cams = useComponentCameras();
  if (cams.length === 0) return null;
  return (
    <>
      {cams.map(([id, cam]) => (
        <Toggle key={id} cam={cam} />
      ))}
    </>
  );
};
