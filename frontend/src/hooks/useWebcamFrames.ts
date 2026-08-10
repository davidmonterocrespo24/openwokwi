/**
 * Stream frames from the user's webcam to the simulator's ESP32-CAM
 * peripheral over WebSocket.
 *
 * Lifecycle:
 *   - start(boardId): asks for camera permission, starts capture loop.
 *   - stop():         turns the webcam off, tells backend to detach.
 *   - status:         'idle' | 'requesting' | 'streaming' | 'denied' | 'error'.
 *
 * The frame transport goes through Esp32Bridge.sendCameraFrame(), which
 * is also what the test suite uses. The ctypes binding in the worker
 * pushes the bytes into the QEMU OV2640+I²S peripheral.
 *
 * Implementation notes:
 *   - QVGA (320×240) at 10 fps. Larger sizes work but bandwidth
 *     scales linearly and the firmware's DMA buffer is fixed-size.
 *   - JPEG output is BOUNDED via `encodeBoundedJpeg` so any webcam
 *     on any PC produces frames that fit in the QEMU 8 KiB cap.
 *     Detail-rich scenes get progressively lower quality; HD/4K
 *     webcams fall back to a 240×180 downscale. See encodeBoundedJpeg.
 *   - We use OffscreenCanvas when available (Chrome/Edge); fall back
 *     to a hidden DOM canvas for Safari < 17.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getEsp32Bridge } from '../store/useSimulatorStore';

export type WebcamStatus =
  | 'idle'
  | 'requesting'
  | 'streaming'
  | 'denied'
  | 'error';

export interface UseWebcamFramesResult {
  status: WebcamStatus;
  errorMessage: string | null;
  /** Frames sent since the last start(). Useful for live counter UI. */
  framesSent: number;
  /** Last frame payload size (bytes). */
  lastFrameBytes: number;
  /** JPEG quality level used for the last frame (0.1 - 0.5). The
   *  encoder drops this dynamically when scenes are too complex to
   *  fit in the emulator's per-frame byte budget. */
  lastQualityUsed: number;
  /** True if the last frame had to be downscaled (the quality ladder
   *  bottomed out). Indicates an HD/4K webcam where even quality 0.1
   *  exceeded MAX_FRAME_BYTES at full QVGA resolution. */
  lastDownscaled: boolean;
  start: (boardId: string) => Promise<void>;
  stop: () => void;
  /** A `<video>` element ref the caller can render for a self-preview. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const FRAME_INTERVAL_MS = 100; // 10 fps

// ── Bounded JPEG encoder ────────────────────────────────────────────────────
// The QEMU walker delivers up to ~32 KiB per frame to the firmware
// (24 EOFs × 1024 samples × MAX_LAPS_PER_BURST=4 wraps on the default
// cam_hal 16-descriptor ring; see qemu-lcgamboa/hw/misc/esp32_i2s_cam.c
// EOFS_PER_FRAME and MAX_LAPS_PER_BURST). The QEMU walker injects FF D9
// at the end of the buffer for safety, but `jpg2rgb565` actually
// parses the structure — so the JPEG must be a complete, valid stream.
//
// Different webcams produce wildly different JPEG sizes for the same
// quality setting (4-7 KiB on cheap fixed cams, 7-10 KiB Logitech-class,
// 10-15 KiB HD/1080p webcams). A single fixed quality cannot cover
// every device.
//
// `encodeBoundedJpeg` GUARANTEES that every emitted frame fits in
// MAX_FRAME_BYTES regardless of webcam hardware or scene complexity:
//   1. Try quality 0.6, 0.5, 0.4, 0.3, 0.2, 0.1 in turn.
//   2. If the worst-case scene still overshoots, downscale the
//      canvas to 240×180 and re-encode at 0.4.
//
// MAX_FRAME_BYTES = 23000 — comfortable margin under the QEMU 32 KiB
// cap, leaving room for the per-frame EOI injection and any framework
// overhead. Bumped from 7800 once the multi-lap walker landed.
const MAX_FRAME_BYTES = 23000;
const QUALITY_LADDER  = [0.6, 0.5, 0.4, 0.3, 0.2, 0.1] as const;
const FALLBACK_W      = 240;
const FALLBACK_H      = 180;

interface EncodedFrame {
  buf: ArrayBuffer;
  bytes: number;
  quality: number;
  downscaled: boolean;
}

/** Run `convertToBlob` / `toBlob` uniformly across OffscreenCanvas and
 *  HTMLCanvasElement. Returns null if the underlying API rejects. */
function canvasToJpeg(
  c: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas) {
    return c.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise((resolve) =>
    (c as HTMLCanvasElement).toBlob(resolve, 'image/jpeg', quality),
  );
}

/** Last-resort fallback for HD/4K webcams: redraw the full-size
 *  canvas onto a smaller scratch canvas. The image content is
 *  preserved (just down-sampled), so JPEG quality 0.3 on a 240×180
 *  canvas almost always lands well below the byte cap. */
function downscaleCanvas(
  src: OffscreenCanvas | HTMLCanvasElement,
  w: number,
  h: number,
): OffscreenCanvas | HTMLCanvasElement {
  let dst: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') {
    dst = new OffscreenCanvas(w, h);
  } else {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    dst = c;
  }
  const ctx = (dst as HTMLCanvasElement).getContext('2d');
  if (ctx) {
    ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
  }
  return dst;
}

/** Encode the canvas to JPEG with progressively lower quality until
 *  the result fits in `maxBytes`. Falls back to a 240×180 downscale
 *  (with its own quality ladder) if full resolution cannot fit.
 *  Returns null when the canvas is invalid, the browser refuses to
 *  encode, or nothing fits the budget — a skipped frame is recoverable,
 *  an oversized one corrupts the guest's frame buffer (truncated EOI). */
async function encodeBoundedJpeg(
  c: OffscreenCanvas | HTMLCanvasElement,
  maxBytes: number,
): Promise<EncodedFrame | null> {
  for (const q of QUALITY_LADDER) {
    const blob = await canvasToJpeg(c, q);
    if (!blob) return null;
    if (blob.size <= maxBytes) {
      return {
        buf: await blob.arrayBuffer(),
        bytes: blob.size,
        quality: q,
        downscaled: false,
      };
    }
  }
  // Worst case: HD/4K webcam, ultra-detailed scene — quality 0.1 at full
  // resolution still overshoots the budget. Downscale and re-run the ladder.
  const small = downscaleCanvas(c, FALLBACK_W, FALLBACK_H);
  for (const q of [0.4, 0.3, 0.2, 0.1]) {
    const blob = await canvasToJpeg(small, q);
    if (!blob) return null;
    if (blob.size <= maxBytes) {
      return {
        buf: await blob.arrayBuffer(),
        bytes: blob.size,
        quality: q,
        downscaled: true,
      };
    }
  }
  return null;
}

export function useWebcamFrames(
  /** Per-board frame byte budget. The default fits the QEMU ESP32-CAM's
   *  32 KiB walker; boards whose camera driver allocates a smaller frame
   *  buffer (the S3's esp32-camera build: width*height/5 for JPEG) must
   *  pass a tighter bound or the JPEG tail — including the EOI marker the
   *  driver scans for — is truncated on copy (cam_hal "NO-EOI"). */
  maxFrameBytes: number = MAX_FRAME_BYTES,
): UseWebcamFramesResult {
  const [status, setStatus] = useState<WebcamStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [framesSent, setFramesSent] = useState(0);
  const [lastFrameBytes, setLastFrameBytes] = useState(0);
  const [lastQualityUsed, setLastQualityUsed] = useState(0.5);
  const [lastDownscaled, setLastDownscaled] = useState(false);

  const maxBytesRef = useRef(maxFrameBytes);
  maxBytesRef.current = maxFrameBytes;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const boardIdRef = useRef<string | null>(null);
  const canvasRef = useRef<OffscreenCanvas | HTMLCanvasElement | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (boardIdRef.current) {
      const bridge = getEsp32Bridge(boardIdRef.current);
      bridge?.sendCameraDetach();
      boardIdRef.current = null;
    }
    setStatus('idle');
    setFramesSent(0);
  }, []);

  const start = useCallback(async (boardId: string) => {
    setStatus('requesting');
    setErrorMessage(null);
    setFramesSent(0);
    boardIdRef.current = boardId;

    // 1. Request camera permission + media stream.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: FRAME_WIDTH,
          height: FRAME_HEIGHT,
          frameRate: { ideal: 10, max: 15 },
        },
        audio: false,
      });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'NotAllowedError') {
        setStatus('denied');
        setErrorMessage('Camera permission denied');
      } else if (e.name === 'NotFoundError') {
        setStatus('error');
        setErrorMessage('No camera detected');
      } else {
        setStatus('error');
        setErrorMessage(e.message ?? 'getUserMedia failed');
      }
      return;
    }
    streamRef.current = stream;

    // 2. Wire stream into a hidden <video> for the canvas to draw from.
    if (!videoRef.current) {
      videoRef.current = document.createElement('video');
      videoRef.current.muted = true;
      videoRef.current.autoplay = true;
      videoRef.current.playsInline = true;
    }
    videoRef.current.srcObject = stream;
    try {
      await videoRef.current.play();
    } catch {
      // Some browsers reject .play() until user gesture; harmless if it
      // throws — the next animation tick will proceed anyway.
    }

    // 3. Prepare canvas for JPEG encode.
    if (!canvasRef.current) {
      if (typeof OffscreenCanvas !== 'undefined') {
        canvasRef.current = new OffscreenCanvas(FRAME_WIDTH, FRAME_HEIGHT);
      } else {
        const c = document.createElement('canvas');
        c.width = FRAME_WIDTH;
        c.height = FRAME_HEIGHT;
        canvasRef.current = c;
      }
    }

    // 4. Tell the backend a frame source is on its way.
    const bridge = getEsp32Bridge(boardId);
    if (!bridge) {
      setStatus('error');
      setErrorMessage(`No ESP32 bridge for board ${boardId}`);
      stop();
      return;
    }
    bridge.sendCameraAttach();

    // 5. Start the capture loop.
    setStatus('streaming');
    timerRef.current = window.setInterval(async () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c || v.readyState < 2) return;

      const ctx = (c as HTMLCanvasElement).getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);

      // Use the bounded encoder so the JPEG always fits in the
      // emulator's per-frame budget regardless of webcam hardware.
      const encoded = await encodeBoundedJpeg(c, maxBytesRef.current);
      if (!encoded) return;
      const id = boardIdRef.current;
      if (!id) return;
      const b = getEsp32Bridge(id);
      if (!b) return;
      // Pass through the source dimensions so the firmware sees the
      // expected camera_fb_t->width/height. The encoder may have
      // internally downscaled to 240×180, but we report 320×240
      // because that's what `esp_camera_fb_get` advertises (and the
      // sketches expect to match cfg.frame_size = FRAMESIZE_QVGA).
      b.sendCameraFrame(encoded.buf, FRAME_WIDTH, FRAME_HEIGHT);
      setFramesSent((n) => n + 1);
      setLastFrameBytes(encoded.bytes);
      setLastQualityUsed(encoded.quality);
      setLastDownscaled(encoded.downscaled);
    }, FRAME_INTERVAL_MS);
  }, [stop]);

  // Stop on unmount.
  useEffect(() => () => stop(), [stop]);

  return {
    status,
    errorMessage,
    framesSent,
    lastFrameBytes,
    lastQualityUsed,
    lastDownscaled,
    start,
    stop,
    videoRef,
  };
}
