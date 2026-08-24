/**
 * micropythonSession — boot a MicroPython board to its raw REPL and put a whole
 * project on it: every auxiliary .py file onto the board filesystem, then the
 * program itself.
 *
 * Why this exists (issue #219). The old path pasted the ENTIRE project into ONE
 * raw-REPL compile unit, with each library file inlined as a single Python
 * string literal:
 *
 *     with open("mqtt_as.py",'w') as _f:
 *         _f.write("...36 KB of escaped source on one line...")
 *
 * A 36 KB library therefore asked MicroPython for one CONTIGUOUS 36 KB
 * allocation on the ~100 KB heap of a PSRAM-less ESP32, and the board answered
 * `MemoryError: memory allocation failed, allocating 36410 bytes` — the file's
 * own size, to within a few bytes. It was never the firmware version.
 *
 * Here nothing is inlined. Each file is written by a SEQUENCE of small
 * executions (`open` / `write(b'...')` x N / `close`) — the shape mpremote's
 * `fs cp` uses against real hardware — so peak guest RAM is a few dozen bytes
 * per step no matter how big the library is. The program itself is written as
 * a file too and started with `execfile`, whose lexer streams from flash: a
 * 100 KB sketch compiles in the same bounded memory a 100-byte one does, and it
 * still runs in the `__main__` namespace, exactly like the pasted code did.
 *
 * Flow control is the second half of the fix. The old code pushed 64 bytes
 * every 150 ms and hoped the guest had drained its UART RX FIFO in between —
 * ~426 B/s, so this project's library alone would have taken 100 s to transfer
 * even if the memory had held. Instead every step is one burst small enough to
 * fit the 128-byte RX FIFO both backends model, followed by a wait for the
 * device's own end-of-execution marker. That marker is proof the guest consumed
 * the burst, so there is never a second burst in flight and never a delay that
 * is not earned. On the in-browser engines the serial callback fires INSIDE the
 * step loop, so the next step is injected mid-tick and the whole upload runs at
 * emulated-CPU speed rather than at browser-frame speed.
 *
 * The session is backend-agnostic: it needs a sink into UART0 RX and a tap on
 * everything the guest prints. The OSS QEMU bridge and the pro in-browser
 * engines share this one implementation — the two hand-ported copies that drift
 * apart are what let this bug live in both.
 */

/** One file to materialise on the board filesystem. */
export interface MpyFile {
  /** Path on the board, e.g. `mqtt_as.py` or `umqtt/simple.py`. */
  name: string;
  content: string;
}

export interface MpyProgram {
  /** Libraries and other modules the program imports. */
  files: MpyFile[];
  /** The program to run (WiFi/stub prelude + the user's main.py). */
  main: string;
}

export type MicroPythonSessionState =
  | 'idle'
  | 'banner_seen'
  | 'prompt_seen'
  | 'uploading'
  | 'running'
  | 'failed';

export interface MicroPythonSessionOptions {
  /** Log prefix, e.g. 'Esp32JsBridge:board-1'. */
  tag?: string;
  /** Delay before the \r poke once the banner is seen (default 400 ms). */
  pokeDelayMs?: number;
  /** Delay before Ctrl-A / the first step on a stage change (default 150 ms). */
  stageDelayMs?: number;
  /**
   * Largest burst pushed into the guest's RX in one go, Ctrl-D included.
   *
   * The ceiling is the 128-byte RX FIFO QEMU models and the mod-128 MEM_RX_STATUS
   * pointers the engines keep; overshoot either and the stream is silently
   * corrupted. The default stays at the 64 every backend has been shipping and
   * proven at, because raising it buys almost nothing here: only ONE burst is
   * ever in flight, so throughput is set by the round trip, not the burst size.
   */
  burstBytes?: number;
  /** How long one step may go unanswered before the upload is failed (default 20 s). */
  stepTimeoutMs?: number;
  /** Progress / error lines for the serial console. */
  onNotice?: (line: string) => void;
  /** Called once the program has been started. */
  onRunning?: () => void;
  /** Called if the upload could not complete; the program never starts. */
  onFailed?: (reason: string) => void;
}

/** The file the program is written to and started from. */
export const MAIN_MODULE_PATH = '_vlx_main.py';

/**
 * Gap between the bursts of a single oversized step. Only the fallback path in
 * pump() uses it: with no end-of-execution marker to wait on mid-statement,
 * this is the same blind pacing the uploader used everywhere before #219.
 */
const OVERFLOW_BURST_DELAY_MS = 150;

const CTRL_A = 0x01;
const CTRL_D = 0x04;
const CR = 0x0d;

/**
 * Sanitize MicroPython source before it is compiled by the board.
 *
 * MicroPython's tokenizer is byte-oriented and the ESP32 build has no wide
 * unicode, so a multi-byte UTF-8 sequence in a comment (Spanish accents, say)
 * makes it report a SyntaxError on an unrelated line. Only comments are
 * rewritten — non-ASCII string literals would fail on the real board too, and
 * identifiers must be ASCII either way.
 *
 * This applies to SOURCE the board compiles. Library files travel as `bytes`
 * literals and are never tokenized on the way in, so they are left untouched:
 * the old code ran this over the one-line literal holding a whole library and
 * its inline-comment rule could eat from a `#` inside the file to the end of
 * it.
 */
export function sanitizeForRepl(code: string): string {
  // 1. Strip UTF-8 BOM if present
  let s = code.startsWith('﻿') ? code.slice(1) : code;
  // 2. Normalize line endings to LF
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 3. Replace non-ASCII in line-comments with '?' so the line is preserved
  s = s.replace(/^([ \t]*#.*)$/gm, (line) => line.replace(/[^\x00-\x7F]/g, '?'));
  // 4. Replace non-ASCII in inline comments (after code on the same line)
  s = s.replace(/([ \t]+#.*)$/gm, (comment) => comment.replace(/[^\x00-\x7F]/g, '?'));
  return s;
}

/** Python single-quoted string literal, ASCII-safe. */
function pyStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** How many source characters one byte costs inside a b'...' literal. */
function byteCost(b: number): number {
  if (b === 0x27 /* ' */ || b === 0x5c /* \ */) return 2;
  if (b >= 0x20 && b < 0x7f) return 1;
  return 4; // \xNN
}

function appendByte(out: string[], b: number): void {
  if (b === 0x27 || b === 0x5c) out.push('\\' + String.fromCharCode(b));
  else if (b >= 0x20 && b < 0x7f) out.push(String.fromCharCode(b));
  else out.push('\\x' + b.toString(16).padStart(2, '0'));
}

interface Step {
  /** The statement to execute on the board. */
  code: string;
  /** Human-readable, for the failure message. */
  label: string;
}

/**
 * Split `bytes` into `_vf.write(b'...')` steps, each of which fits in one
 * burst. Packing is greedy on the ENCODED length rather than a fixed byte
 * count: a line of ordinary Python costs one character per byte, a newline
 * costs four, and sizing on the encoded form is what keeps the burst under the
 * FIFO for both.
 */
function writeSteps(bytes: Uint8Array, path: string, burstBytes: number): Step[] {
  const steps: Step[] = [];
  const overhead = "_vf.write(b'')".length + 1; // + Ctrl-D
  const budget = Math.max(16, burstBytes - overhead);
  let i = 0;
  while (i < bytes.length) {
    const parts: string[] = [];
    let cost = 0;
    while (i < bytes.length) {
      const c = byteCost(bytes[i]);
      if (cost + c > budget) break;
      appendByte(parts, bytes[i]);
      cost += c;
      i++;
    }
    steps.push({ code: `_vf.write(b'${parts.join('')}')`, label: path });
  }
  return steps;
}

/** Directories that must exist before these files can be opened, parents first. */
function dirsFor(files: MpyFile[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const segs = f.name.split('/').slice(0, -1);
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  return [...dirs].sort();
}

export class MicroPythonSession {
  private buffer = '';
  private _state: MicroPythonSessionState = 'idle';
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  private readonly tag: string;
  private readonly pokeDelayMs: number;
  private readonly stageDelayMs: number;
  private readonly burstBytes: number;
  private readonly stepTimeoutMs: number;
  private readonly onNotice?: (line: string) => void;
  private readonly onRunning?: () => void;
  private readonly onFailed?: (reason: string) => void;

  private steps: Step[] = [];
  private stepIndex = 0;
  /** Ctrl-D markers seen since the running step was handed to the board. */
  private eotSeen = 0;
  /** Text between the first and second Ctrl-D: the board's traceback, if any. */
  private errText = '';
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bytes of the running step not yet pushed (only ever non-empty on the
   *  oversized-step fallback in pump()). */
  private outbox: number[] = [];
  /** Characters of the board's `>`+`OK` still to swallow after the handover. */
  private okToSwallow = 0;
  private startedAt = 0;
  private totalBytes = 0;

  private readonly sendSerialBytes: (bytes: number[]) => void;
  private readonly program: MpyProgram;

  constructor(
    sendSerialBytes: (bytes: number[]) => void,
    program: MpyProgram,
    opts: MicroPythonSessionOptions = {},
  ) {
    this.sendSerialBytes = sendSerialBytes;
    this.program = program;
    this.tag = opts.tag ?? 'MicroPythonSession';
    this.pokeDelayMs = opts.pokeDelayMs ?? 400;
    this.stageDelayMs = opts.stageDelayMs ?? 150;
    this.burstBytes = opts.burstBytes ?? 64;
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 20_000;
    this.onNotice = opts.onNotice;
    this.onRunning = opts.onRunning;
    this.onFailed = opts.onFailed;
  }

  get state(): MicroPythonSessionState {
    return this._state;
  }

  /** Cancel everything pending (SoC restart / disconnect). Terminal. */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = null;
  }

  /**
   * Feed everything the guest prints. Returns the part of it the serial console
   * should show: the boot banner and the program's own output pass through, the
   * upload's protocol chatter (hundreds of `OK`/Ctrl-D/`>` exchanges) does not.
   */
  feed(text: string): string {
    if (this.disposed) return text;
    if (this._state === 'failed') return text;

    if (this._state === 'running') {
      // The program owns the stream now. Two leftovers of the protocol are
      // still worth hiding: the `OK` the board prints to acknowledge the
      // statement that started it, and the Ctrl-D pair it prints when the
      // program finally returns.
      let out = '';
      for (const ch of text) {
        // '>' is the previous step's prompt, 'OK' the board acknowledging the
        // one that starts the program. Both land after the handover.
        if (this.okToSwallow > 0 && (ch === '>' || ch === 'O' || ch === 'K')) {
          this.okToSwallow--;
          continue;
        }
        this.okToSwallow = 0;
        if (ch !== '\x04') out += ch;
      }
      return out;
    }

    if (this._state === 'uploading') {
      this.consumeUploadOutput(text);
      return '';
    }

    this.buffer += text;

    // From Ctrl-A onward the board is answering the handshake, not the user:
    // 'raw REPL; CTRL-B to exit' and its prompt are ours. Hiding the whole
    // banner beats hiding half of it — the match completes mid-word, so
    // showing up to that point left a truncated 'raw REP' in the monitor.
    const visible = this._state === 'prompt_seen' ? '' : text;

    // Stage 1: banner seen -> poke \r. The QEMU chardev holds the '>>> ' prompt
    // (it has no trailing newline) until another write flushes it, so over there
    // this poke is what makes the prompt appear at all.
    //
    // It is NOT harmless once the prompt has arrived on its own. The in-browser
    // engines deliver serial per byte, so '>>>' follows the banner inside the
    // SAME feed(): stage 2 arms Ctrl-A at +150 ms while this timer is still
    // pending at +400 ms, and the poke then lands 250 ms AFTER Ctrl-A — that is,
    // inside the code stream. MicroPython reads a lone \r as a newline, so it
    // cut a source line in half and every sketch died with a SyntaxError on a
    // line the user never wrote. Hence the guard: poke only while the prompt is
    // still missing.
    if (this._state === 'idle' && this.buffer.includes('Type "help()"')) {
      this._state = 'banner_seen';
      this.later(() => {
        if (this._state !== 'banner_seen') return; // prompt already arrived
        this.sendSerialBytes([CR]);
      }, this.pokeDelayMs);
    }

    // Stage 2: interactive '>>>' prompt -> enter raw REPL with Ctrl-A.
    if (this._state === 'banner_seen' && this.buffer.includes('>>>')) {
      this._state = 'prompt_seen';
      this.buffer = '';
      this.later(() => this.sendSerialBytes([CTRL_A]), this.stageDelayMs);
    }

    // Stage 3: 'raw REPL; CTRL-B to exit' confirmed -> start uploading. The
    // state moves NOW, not when beginUpload() fires: the board keeps printing
    // through the stage delay, and a second match would queue a second upload.
    if (this._state === 'prompt_seen' && this.buffer.includes('raw REPL')) {
      this._state = 'uploading';
      this.buffer = '';
      this.later(() => this.beginUpload(), this.stageDelayMs);
      return '';
    }

    // Keep the buffer bounded while the guest boots.
    if (this.buffer.length > 8192) this.buffer = this.buffer.slice(-1024);
    return visible;
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  private beginUpload(): void {
    if (this.disposed) return;
    const enc = new TextEncoder();
    const steps: Step[] = [];

    // A packaged module ("umqtt/simple.py" — how micropython-lib ships
    // umqtt.simple) needs its directory first: MicroPython's open() does not
    // mkdir, and without this the upload died with ENOENT.
    for (const d of dirsFor(this.program.files)) {
      steps.push({
        code: `try:\n __import__('os').mkdir(${pyStr(d)})\nexcept OSError:pass`,
        label: `mkdir ${d}`,
      });
    }

    const files: MpyFile[] = [
      ...this.program.files,
      { name: MAIN_MODULE_PATH, content: sanitizeForRepl(this.program.main) },
    ];
    for (const f of files) {
      const bytes = enc.encode(f.content);
      this.totalBytes += bytes.length;
      steps.push({ code: `_vf=open(${pyStr(f.name)},'wb')`, label: f.name });
      steps.push(...writeSteps(bytes, f.name, this.burstBytes));
      steps.push({ code: '_vf.close()', label: f.name });
    }

    // execfile streams the source off the filesystem instead of holding it in
    // RAM, and runs it in these globals — so a 100 KB sketch compiles in the
    // same memory a 100-byte one does, and the program still sees
    // __name__ == '__main__', exactly as it did when it was pasted.
    //
    // Every ESP32 build ships execfile, but the name is a build option, and
    // falling back is two lines: the guard covers only the NAME lookup, so a
    // NameError raised by the program itself is still the program's.
    steps.push({
      code: "_r=getattr(__import__('builtins'),'execfile',None)",
      label: 'run',
    });
    steps.push({
      code: 'if _r is None:_r=lambda p:exec(open(p).read(),globals())',
      label: 'run',
    });
    steps.push({ code: `_r(${pyStr(MAIN_MODULE_PATH)})`, label: 'run' });

    this.steps = steps;
    this.stepIndex = 0;
    this._state = 'uploading';
    this.startedAt = Date.now();
    const n = this.program.files.length;
    if (n > 0) {
      this.notice(
        `[velxio] uploading ${n} file${n === 1 ? '' : 's'} to the board filesystem ` +
          `(${this.totalBytes} bytes, ${steps.length} steps)`,
      );
    }
    console.log(`[${this.tag}] raw REPL confirmed - ${steps.length} steps, ${this.totalBytes} bytes`);
    this.sendStep();
  }

  /** Hand the current step to the board and start its answer's deadline. */
  private sendStep(): void {
    if (this.disposed || this._state !== 'uploading') return;
    const step = this.steps[this.stepIndex];
    this.eotSeen = 0;
    this.errText = '';
    this.outbox = Array.from(new TextEncoder().encode(step.code));
    // Arm the deadline BEFORE pushing. A backend that answered inside the send
    // would otherwise complete this step, start the next one, and then have
    // this line overwrite the new step's deadline with one already spent.
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = setTimeout(() => {
      this.fail(`the board stopped answering while writing ${step.label}`);
    }, this.stepTimeoutMs);
    this.pump();
  }

  /**
   * Push the current step out, then Ctrl-D to execute it.
   *
   * Every step this builds fits in one burst, which is the whole point: one
   * burst in flight, and the board's answer is what releases the next. A step
   * can only overflow on a pathologically long file path (the `open` line
   * carries it verbatim), and rather than let that corrupt the stream it falls
   * back to the old timed pacing for those few bursts alone.
   */
  private pump(): void {
    if (this.disposed || this._state === 'failed') return;
    if (this.outbox.length <= this.burstBytes) {
      const last = this.outbox;
      this.outbox = [];
      this.sendSerialBytes([...last, CTRL_D]);
      return;
    }
    this.sendSerialBytes(this.outbox.slice(0, this.burstBytes));
    this.outbox = this.outbox.slice(this.burstBytes);
    this.later(() => this.pump(), OVERFLOW_BURST_DELAY_MS);
  }

  /**
   * Watch the board's answer to the running step. In raw REPL it replies `OK`,
   * then the statement's output, then Ctrl-D, then the traceback (empty when it
   * succeeded), then Ctrl-D and the `>` prompt. Two Ctrl-Ds mean the guest has
   * consumed the whole burst and is ready — the only signal worth pacing on.
   */
  private consumeUploadOutput(text: string): void {
    // Nothing is in flight between stage 3 and the first step; the board is
    // only finishing its raw-REPL banner.
    if (this.steps.length === 0) return;
    for (const ch of text) {
      if (ch === '\x04') {
        this.eotSeen++;
        if (this.eotSeen === 2) {
          this.finishStep();
          return;
        }
      } else if (this.eotSeen === 1) {
        this.errText += ch;
      }
    }
  }

  private finishStep(): void {
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    const step = this.steps[this.stepIndex];
    const err = this.errText.trim();
    if (err) {
      this.fail(`${step.label}: ${err.split('\n').pop() ?? err}`);
      return;
    }
    this.stepIndex++;
    if (this.stepIndex >= this.steps.length) {
      // Cannot happen: the last step is execfile, which hands over below.
      this._state = 'running';
      return;
    }
    if (this.stepIndex === this.steps.length - 1) {
      // Everything is on the filesystem; the next step starts the program and
      // its output belongs to the user, not to us.
      const ms = Date.now() - this.startedAt;
      if (this.program.files.length > 0) {
        this.notice(`[velxio] upload complete in ${(ms / 1000).toFixed(1)}s - starting program`);
      }
      this.outbox = Array.from(new TextEncoder().encode(this.steps[this.stepIndex].code));
      this._state = 'running';
      this.okToSwallow = 3;
      this.pump();
      this.onRunning?.();
      return;
    }
    this.sendStep();
  }

  private fail(reason: string): void {
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    this._state = 'failed';
    console.error(`[${this.tag}] upload failed: ${reason}`);
    this.notice(`[velxio] could not load the project onto the board - ${reason}`);
    this.onFailed?.(reason);
  }

  private notice(line: string): void {
    this.onNotice?.(`\r\n${line}\r\n`);
  }

  private later(fn: () => void, ms: number): void {
    if (this.disposed) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(t);
  }
}
