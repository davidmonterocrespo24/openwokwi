/**
 * Header indicator for components that own a webcam.
 *
 * Boards with a camera get the header CameraToggle, but that path is
 * board-plumbing (frames into the guest's DVP). Some COMPONENTS are cameras
 * too — vision sensors whose element captures the webcam itself. Without a
 * header presence their camera state lives only in the tiny art on the
 * canvas, and a user who has learned "the header icon tells me when my
 * webcam is in use" reads its absence as "the camera is not working".
 *
 * A component that runs a webcam registers here on attach and keeps its
 * entry updated; the header renders one toggle per entry, styled like
 * CameraToggle (green live, red failed with the reason, grey off). The
 * registry is a seam: OSS renders whatever registered, overlays register.
 */
import { useSyncExternalStore } from 'react';

export interface ComponentCameraEntry {
  /** Short button label, e.g. "Gesture cam". */
  label: string;
  status: 'off' | 'live' | 'error';
  /** Why the camera is not running, shown in the tooltip when status=error. */
  reason?: string;
  /** Click handler: switch the component's camera on/off (or retry). */
  toggle: () => void;
}

const entries = new Map<string, ComponentCameraEntry>();
const listeners = new Set<() => void>();
// useSyncExternalStore wants a STABLE snapshot between changes.
let snapshot: Array<[string, ComponentCameraEntry]> = [];

function emit(): void {
  snapshot = Array.from(entries.entries());
  listeners.forEach((l) => l());
}

/** Add or update a component's camera entry (keyed by component id). */
export function setComponentCamera(id: string, entry: ComponentCameraEntry): void {
  entries.set(id, entry);
  emit();
}

export function removeComponentCamera(id: string): void {
  if (entries.delete(id)) emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot(): Array<[string, ComponentCameraEntry]> {
  return snapshot;
}

/** All registered component cameras, newest last. Empty for most projects. */
export function useComponentCameras(): Array<[string, ComponentCameraEntry]> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
