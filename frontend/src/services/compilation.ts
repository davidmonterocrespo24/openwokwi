import axios from 'axios';
import { getApiBase } from '../lib/apiBase';
import type { ESP32BoardOptions, SpiffsFile } from '../types/boardOptions';

export interface SketchFile {
  name: string;
  content: string;
}

/**
 * Per-board build options forwarded to the backend. Only meaningful for
 * ESP32 targets — `board_options` is structurally translated into sdkconfig
 * knobs and a generated partitions.csv by the ESP-IDF compiler. `spiffs_files`
 * (if non-empty) are baked into a SPIFFS partition image via `mkspiffs`.
 */
export interface CompileExtras {
  boardOptions?: ESP32BoardOptions;
  spiffsFiles?: SpiffsFile[];
  // P2.3 — declared library manifest (the loaded example/project's libraries).
  // Sent as the ESP-IDF resolution SCOPE; null/omitted = legacy scan-all.
  // Ignored by the backend for non-ESP32 (arduino-cli) boards.
  libraries?: string[] | null;
  // Pure ESP-IDF mode (issue #139): 'espidf' compiles the files as a pure
  // ESP-IDF project (user app_main, no arduino-esp32 component). Omitted /
  // undefined = classic Arduino sketch compile. ESP32 boards only.
  language?: 'espidf';
  // Who triggered the compile — 'agent' when the AI assistant's tool did.
  // Threads through to backend metrics; omitted = manual user action.
  initiatedBy?: 'agent';
  // The editor's BoardKind — analytics only. Distinct boards can share one
  // FQBN (Pimoroni RP2350 boards all compile as rpipico2); the kind is the
  // only identifier that tells them apart in the metrics.
  boardKind?: string;
  // Gallery example the workspace was loaded from — analytics only
  // ("which examples get compiled most"). Null/omitted outside examples.
  exampleId?: string | null;
}

export interface CompileResult {
  success: boolean;
  hex_content?: string;
  binary_content?: string; // base64-encoded .bin for RP2040
  binary_type?: 'bin' | 'uf2';
  has_wifi?: boolean; // True when sketch uses WiFi (ESP32 only)
  stdout: string;
  stderr: string;
  error?: string;
  core_install_log?: string;
  /** P2.4 — the manifest is missing libraries the build really used. */
  manifest_incomplete?: boolean;
  /** { header: [candidate library display names] } — single-candidate
   * entries are safe to auto-declare (see utils/libraryManifest.ts). */
  manifest_suggested_libraries?: Record<string, string[]> | null;
}

interface CompileStartResponse {
  job_id: string;
}

interface CompileStatusResponse {
  state: 'pending' | 'running' | 'done' | 'error';
  started_at: number;
  finished_at: number | null;
  stdout: string;
  result: CompileResult | null;
  error: string | null;
}

/**
 * Live progress callback — called on every poll while state ∈ {pending,
 * running}, plus one final call with state 'done' carrying the complete
 * buffer (the lines that landed between the last running-poll and job
 * completion would otherwise never be delivered). `stdout` is the full live
 * cmake + ninja output captured so far (cap of ~256 KB on the server side,
 * tail kept). Caller can compute a delta against the previous call if it
 * wants to append-only render.
 */
export type CompileProgress = (info: {
  state: 'pending' | 'running' | 'done';
  stdout: string;
  elapsedSeconds: number;
}) => void;

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_DURATION_MS = 15 * 60 * 1000; // 15 minutes — covers cold ESP-IDF builds

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Compile a sketch via the async job pipeline.
 *
 *   POST /compile/start                  → { job_id }
 *   GET  /compile/status/<job_id>  (×N)  → { state, stdout, result?, error? }
 *
 * Each individual request returns in milliseconds, so Cloudflare's 100s edge
 * timeout never kicks in — even when the underlying ESP-IDF cold build runs
 * for 5-7 minutes. Falls back to throwing an Error after MAX_POLL_DURATION_MS.
 *
 * `onProgress` (optional): called every poll with the live cmake + ninja
 * output so the editor can stream the compilation console instead of
 * waiting for everything at the end.
 */
export async function compileCode(
  files: SketchFile[],
  board: string = 'arduino:avr:uno',
  projectId?: string | null,
  onProgress?: CompileProgress,
  extras?: CompileExtras,
): Promise<CompileResult> {
  console.log('Sending compilation request to:', `${getApiBase()}/compile/start`);
  console.log('Board:', board);
  console.log(
    'Files:',
    files.map((f) => f.name),
  );

  // Translate camelCase frontend keys to snake_case backend keys. Backend
  // only inspects these fields for esp32:* FQBNs — other boards pass them
  // through unread.
  const board_options = extras?.boardOptions ? { ...extras.boardOptions } : null;
  const spiffs_files = extras?.spiffsFiles?.length
    ? extras.spiffsFiles.map((f) => ({ name: f.name, content_b64: f.contentB64 }))
    : null;
  // P2.3 — library manifest (resolution scope). null = legacy scan-all.
  const libraries = extras?.libraries && extras.libraries.length ? extras.libraries : null;

  let jobId: string;
  try {
    const startResp = await axios.post<CompileStartResponse>(
      `${getApiBase()}/compile/start`,
      {
        files,
        board_fqbn: board,
        project_id: projectId ?? null,
        board_options,
        spiffs_files,
        board_kind: extras?.boardKind ?? null,
        example_id: extras?.exampleId ?? null,
        libraries,
        language: extras?.language ?? null,
        initiated_by: extras?.initiatedBy ?? null,
      },
      { withCredentials: true, timeout: 30000 },
    );
    jobId = startResp.data.job_id;
    console.log('[compile] queued job', jobId);
  } catch (error) {
    console.error('Compilation request failed:', error);
    if (axios.isAxiosError(error) && error.response) {
      // Server returned a structured error (422, 500, etc.) — surface as a
      // failed CompileResult so the editor can show stderr/error.
      return error.response.data as CompileResult;
    }
    throw error instanceof Error
      ? error
      : new Error('No response from server. Is the backend running?');
  }

  const startedAt = Date.now();
  // Initial small delay so we don't hit /status before the background task
  // has even moved past 'pending'.
  await sleep(500);

  while (true) {
    if (Date.now() - startedAt > MAX_POLL_DURATION_MS) {
      throw new Error(
        `Compile timed out client-side after ${Math.round(MAX_POLL_DURATION_MS / 1000)}s`,
      );
    }

    let status: CompileStatusResponse;
    try {
      const resp = await axios.get<CompileStatusResponse>(
        `${getApiBase()}/compile/status/${jobId}`,
        { withCredentials: true, timeout: 30000 },
      );
      status = resp.data;
    } catch (error) {
      // Transient poll error — log, wait, retry. Only abort on 404 (job
      // expired or never existed).
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(`Compile job ${jobId} not found (server may have restarted)`);
      }
      console.warn('[compile] status poll error, retrying:', error);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (status.state === 'done' && status.result) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[compile] job ${jobId} done in ${elapsed}s`);
      // Final flush: the buffer grew between the last running-poll and
      // completion (esptool + binary-size lines usually live there).
      if (onProgress) {
        try {
          onProgress({ state: 'done', stdout: status.stdout || '', elapsedSeconds: elapsed });
        } catch (err) {
          console.warn('[compile] onProgress threw:', err);
        }
      }
      return status.result;
    }

    if (status.state === 'error') {
      console.error(`[compile] job ${jobId} errored:`, status.error);
      return {
        success: false,
        stdout: status.stdout || '',
        stderr: '',
        error: status.error || 'Compile failed',
      };
    }

    // state ∈ {pending, running} — surface live build output if requested
    if (onProgress) {
      try {
        onProgress({
          state: status.state,
          stdout: status.stdout || '',
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        });
      } catch (err) {
        // A faulty UI hook must never break the polling loop.
        console.warn('[compile] onProgress threw:', err);
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
