/**
 * Stream the computer's microphone into a board's emulated on-board mic.
 *
 * Lifecycle:
 *   - start(boardId): asks for mic permission, wires the capture chain.
 *   - stop():         releases the mic; the bridge falls back to its
 *                     built-in 440 Hz test tone.
 *   - status:         'idle' | 'requesting' | 'streaming' | 'denied' | 'error'.
 *
 * The transport is the bridge's setMicrophoneSource(fn) seam: the engine's
 * I2S RX fill pulls one signed 16-bit sample per call, passing the rate the
 * guest programmed. Boards whose bridge lacks the seam (QEMU path, non-audio
 * bridges) are reported as an error instead of pretending to stream.
 *
 * Implementation notes:
 *   - Capture runs at the AudioContext's native rate (typically 48 kHz) and
 *     is decimated to 16 kHz by fractional stepping — the emulated PDM mic is
 *     a level-meter-grade source, not a hi-fi path. The reader then resamples
 *     that ring to whatever rate the sketch asked for.
 *   - The engine paces its pulls in SIMULATED cpu cycles, so during the boot
 *     boost it can consume up to 4x faster than real time. A 2 s ring buffer
 *     absorbs jitter; underflow reads as silence (0), overflow drops the
 *     oldest audio. Both are the honest behaviours for a live mic.
 *   - ScriptProcessorNode is deprecated but universal and needs no worklet
 *     module loading (CSP-proof). Its output buffer is never written, so
 *     nothing echoes to the speakers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getEsp32Bridge, useSimulatorStore } from '../store/useSimulatorStore';

export type MicStatus = 'idle' | 'requesting' | 'streaming' | 'denied' | 'error';

export interface UseMicrophoneStreamResult {
  status: MicStatus;
  errorMessage: string | null;
  /** Peak level of the last capture block, 0..1. Drives the live meter. */
  level: number;
  start: (boardId: string) => Promise<void>;
  stop: () => void;
}

/** The emulated microphone's sample rate (what the I2S RX path pulls at). */
const MIC_HZ = 16_000;
/** Ring capacity: 2 s of audio at MIC_HZ. */
const RING_CAPACITY = MIC_HZ * 2;

interface MicBridge {
  /** The source is called once per sample and is handed the rate the guest
   *  configured, so it can resample the captured audio to match. */
  setMicrophoneSource?: (s: ((hz?: number) => number) | null) => void;
}

export function useMicrophoneStream(): UseMicrophoneStreamResult {
  const [status, setStatus] = useState<MicStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const boardIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceFnRef = useRef<(() => number) | null>(null);

  const stop = useCallback(() => {
    if (boardIdRef.current) {
      // null = back to the bridge's built-in test tone.
      (getEsp32Bridge(boardIdRef.current) as MicBridge | undefined)?.setMicrophoneSource?.(null);
    }
    sourceFnRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    boardIdRef.current = null;
    setStatus('idle');
    setLevel(0);
  }, []);

  const start = useCallback(
    async (boardId: string) => {
      setStatus('requesting');
      setErrorMessage(null);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        if (e.name === 'NotAllowedError') {
          setStatus('denied');
          setErrorMessage('Microphone permission denied');
        } else if (e.name === 'NotFoundError') {
          setStatus('error');
          setErrorMessage('No microphone detected');
        } else {
          setStatus('error');
          setErrorMessage(e.message ?? 'getUserMedia failed');
        }
        return;
      }

      const bridge = getEsp32Bridge(boardId) as MicBridge | undefined;
      if (typeof bridge?.setMicrophoneSource !== 'function') {
        stream.getTracks().forEach((t) => t.stop());
        setStatus('error');
        setErrorMessage('This board has no microphone input path');
        return;
      }

      // 16 kHz signed 16-bit ring between the capture callback (writer) and
      // the engine's per-sample pull (reader).
      const ring = new Int16Array(RING_CAPACITY);
      let readPos = 0;
      let writePos = 0;
      let count = 0;

      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        stream.getTracks().forEach((t) => t.stop());
        setStatus('error');
        setErrorMessage('AudioContext unavailable');
        return;
      }
      const ctx = new Ctor();
      // The toggle click is the user gesture that unlocks a suspended context.
      void ctx.resume().catch(() => {});
      const micNode = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const step = ctx.sampleRate / MIC_HZ;
      let frac = 0;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        let peak = 0;
        for (let j = 0; j < input.length; j++) {
          const a = input[j] < 0 ? -input[j] : input[j];
          if (a > peak) peak = a;
        }
        let i = frac;
        for (; i < input.length; i += step) {
          const v = Math.max(-1, Math.min(1, input[Math.floor(i)]));
          ring[writePos] = (v * 32767) | 0;
          writePos = (writePos + 1) % RING_CAPACITY;
          if (count < RING_CAPACITY) {
            count++;
          } else {
            readPos = (readPos + 1) % RING_CAPACITY; // overflow: drop oldest
          }
        }
        frac = i - input.length;
        setLevel(Math.round(peak * 100) / 100);
      };
      micNode.connect(processor);
      // ScriptProcessor only fires while routed to the destination; its
      // output buffer stays zeroed, so nothing is audible.
      processor.connect(ctx.destination);

      // How much of the CAPTURED stream one guest sample covers. The ring is
      // written at MIC_HZ, so a sketch recording at 8 kHz must consume two
      // captured samples per read or its audio plays back at half speed, and
      // one at 44.1 kHz consumes less than one (zero-order hold). The engine
      // passes the rate it decoded from the guest's own clock registers.
      let readFrac = 0;
      const sourceFn = (hz?: number) => {
        if (count === 0) return 0; // starved: emulation pulling ahead of real time
        const s = ring[readPos];
        readFrac += hz && hz > 0 ? MIC_HZ / hz : 1;
        const advance = Math.floor(readFrac);
        readFrac -= advance;
        for (let k = 0; k < advance && count > 0; k++) {
          readPos = (readPos + 1) % RING_CAPACITY;
          count--;
        }
        return s;
      };
      bridge.setMicrophoneSource(sourceFn);

      boardIdRef.current = boardId;
      streamRef.current = stream;
      ctxRef.current = ctx;
      processorRef.current = processor;
      sourceFnRef.current = sourceFn;
      setStatus('streaming');
    },
    [],
  );

  // The pro DelegatingEsp32Bridge stashes the source across Run/Stop cycles,
  // but a board-type change rebuilds the whole wrapper and loses it. Re-apply
  // on every run start so the stream survives either path.
  const running = useSimulatorStore((st) => st.running);
  useEffect(() => {
    if (!running || status !== 'streaming' || !boardIdRef.current || !sourceFnRef.current) return;
    (getEsp32Bridge(boardIdRef.current) as MicBridge | undefined)?.setMicrophoneSource?.(
      sourceFnRef.current,
    );
  }, [running, status]);

  // Release the mic when the owner unmounts.
  useEffect(() => stop, [stop]);

  return { status, errorMessage, level, start, stop };
}
