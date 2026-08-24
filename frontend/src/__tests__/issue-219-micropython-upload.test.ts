/**
 * Issue #219 — "MemoryError: memory allocation failed, allocating 36410 bytes"
 * when a project imports a large MicroPython library (mqtt_as, 36407 bytes).
 *
 * The board was not out of memory in any general sense: the old uploader
 * inlined each library file into the program as ONE Python string literal, so
 * compiling it demanded a single contiguous allocation the size of the file.
 * 36407 bytes of source, 36410 bytes requested, ~100 KB heap on a PSRAM-less
 * ESP32 — it could not have worked, on any firmware version.
 *
 * These tests drive the uploader against a board stub that actually executes
 * what it is sent, and hold the two properties the fix rests on: no step is
 * ever big enough to be the problem again, and the file that lands on the
 * board is byte-for-byte the file that left.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MicroPythonSession, MAIN_MODULE_PATH } from '../simulation/micropythonSession';

/** The RX FIFO both backends model. Nothing may exceed it in one burst. */
const RX_FIFO = 128;
/** The default burst, plus the Ctrl-D that rides along with the last one. */
const BURST = 64 + 1;

/**
 * A MicroPython board, in as much detail as the raw REPL needs: it accepts
 * bursts, executes the handful of statements the uploader emits, and answers
 * with the protocol's `OK` / Ctrl-D / Ctrl-D / `>`.
 *
 * Output is queued rather than pushed straight back, so a 600-step upload is a
 * loop instead of 600 nested calls.
 */
class FakeBoard {
  readonly fs = new Map<string, number[]>();
  readonly bursts: number[] = [];
  readonly executed: string[] = [];
  ran: string | null = null;
  /** Make the Nth executed statement fail, the way a full filesystem would. */
  failOnStep = -1;
  private line = '';
  private handle: number[] | null = null;
  private handleName = '';
  private readonly pending: string[] = [];
  private session!: MicroPythonSession;
  /** Everything the console was shown, i.e. what feed() let through. */
  console = '';

  attach(s: MicroPythonSession): void {
    this.session = s;
  }

  receive(bytes: number[]): void {
    this.bursts.push(bytes.length);
    for (const b of bytes) {
      if (b === 0x04) {
        this.execute(this.line);
        this.line = '';
      } else if (b === 0x01) {
        this.pending.push('raw REPL; CTRL-B to exit\r\n>');
      } else if (b === 0x0d) {
        this.pending.push('\r\n>>> ');
      } else {
        this.line += String.fromCharCode(b);
      }
    }
  }

  /** Feed the guest's output into the session until nothing more is produced. */
  pump(): void {
    let guard = 100_000;
    while (this.pending.length && guard-- > 0) {
      this.console += this.session.feed(this.pending.shift()!);
    }
  }

  say(text: string): void {
    this.pending.push(text);
    this.pump();
  }

  private execute(code: string): void {
    this.executed.push(code);
    let err = '';
    try {
      if (this.executed.length === this.failOnStep) throw new Error('OSError: 28');
      const open = /^_vf=open\('(.*)','wb'\)$/.exec(code);
      const write = /^_vf\.write\(b'(.*)'\)$/s.exec(code);
      if (open) {
        this.handleName = open[1];
        this.handle = [];
      } else if (write) {
        if (!this.handle) throw new Error('write to a closed file');
        this.handle.push(...decodeBytesLiteral(write[1]));
      } else if (code === '_vf.close()') {
        if (!this.handle) throw new Error('close of a closed file');
        this.fs.set(this.handleName, this.handle);
        this.handle = null;
      } else if (code.startsWith('try:')) {
        /* mkdir — always succeeds here */
      } else if (code.startsWith('_r=getattr(') || code.startsWith('if _r is None:')) {
        /* resolving execfile; this board has it */
      } else if (code.startsWith('_r(')) {
        const name = /^_r\('(.*)'\)$/.exec(code)![1];
        if (!this.fs.has(name)) throw new Error(`OSError: ${name} missing`);
        this.ran = name;
      } else {
        throw new Error(`unexpected statement: ${code}`);
      }
    } catch (e) {
      err = `Traceback (most recent call last):\r\n  ${(e as Error).message}`;
    }
    this.pending.push(`OK\x04${err}\x04>`);
  }
}

function decodeBytesLiteral(lit: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < lit.length; i++) {
    if (lit[i] !== '\\') {
      out.push(lit.charCodeAt(i));
    } else if (lit[i + 1] === 'x') {
      out.push(parseInt(lit.slice(i + 2, i + 4), 16));
      i += 3;
    } else {
      out.push(lit.charCodeAt(i + 1));
      i += 1;
    }
  }
  return out;
}

function boot(board: FakeBoard): void {
  board.say('MicroPython v1.28.0 on 2026-04-06; ESP32 module with ESP32\r\n');
  board.say('Type "help()" for more information.\r\n');
  vi.advanceTimersByTime(50);
  board.pump();
  board.say('>>> ');
  vi.advanceTimersByTime(50);
  board.pump();
  // Ctrl-A was queued by the stage; let it and every following step settle.
  for (let i = 0; i < 20 && !board.ran; i++) {
    vi.advanceTimersByTime(50);
    board.pump();
  }
}

function textOf(bytes: number[] | undefined): string {
  return new TextDecoder().decode(new Uint8Array(bytes ?? []));
}

describe('issue #219 — MicroPython project upload', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('puts a 36 KB library on the board byte-for-byte', () => {
    // The shape of the file from the reporter's project: long, mostly
    // printable, with the quotes and backslashes that break naive escaping.
    const library =
      '# mqtt_as.py\n' +
      Array.from({ length: 1200 }, (_, i) => `LINE_${i} = "a\\tb'c" + str(${i})`).join('\n') +
      '\n';
    expect(library.length).toBeGreaterThan(30_000);

    const board = new FakeBoard();
    const session = new MicroPythonSession((b) => board.receive(b), {
      files: [{ name: 'mqtt_as.py', content: library }],
      main: 'import mqtt_as\nprint("up")\n',
    });
    board.attach(session);
    boot(board);

    expect(session.state).toBe('running');
    expect(textOf(board.fs.get('mqtt_as.py'))).toBe(library);
    expect(board.ran).toBe(MAIN_MODULE_PATH);
    expect(textOf(board.fs.get(MAIN_MODULE_PATH))).toContain('import mqtt_as');
  });

  it('never asks the board for an allocation the size of the file', () => {
    const library = 'X'.repeat(36_407);
    const board = new FakeBoard();
    const session = new MicroPythonSession((b) => board.receive(b), {
      files: [{ name: 'mqtt_as.py', content: library }],
      main: 'print("up")\n',
    });
    board.attach(session);
    boot(board);

    // This is the regression itself: the old uploader emitted ONE statement
    // holding the whole file, and the board answered MemoryError.
    const longest = Math.max(...board.executed.map((c) => c.length));
    expect(longest).toBeLessThan(RX_FIFO);
    // And the burst budget itself holds, which is the tighter claim: one burst
    // in flight, small enough that no backend's FIFO accounting can alias.
    expect(Math.max(...board.bursts)).toBeLessThanOrEqual(BURST);
    expect(textOf(board.fs.get('mqtt_as.py'))).toBe(library);
  });

  it('creates the directory a packaged module needs before opening it', () => {
    const board = new FakeBoard();
    const session = new MicroPythonSession((b) => board.receive(b), {
      files: [{ name: 'umqtt/simple.py', content: 'class MQTTClient:\n    pass\n' }],
      main: 'from umqtt.simple import MQTTClient\n',
    });
    board.attach(session);
    boot(board);

    const mkdir = board.executed.findIndex((c) => c.includes("mkdir('umqtt')"));
    const open = board.executed.findIndex((c) => c.includes("open('umqtt/simple.py'"));
    expect(mkdir).toBeGreaterThanOrEqual(0);
    expect(mkdir).toBeLessThan(open);
    expect(textOf(board.fs.get('umqtt/simple.py'))).toContain('class MQTTClient');
  });

  it('keeps the upload protocol out of the serial console', () => {
    const board = new FakeBoard();
    const session = new MicroPythonSession((b) => board.receive(b), {
      files: [{ name: 'lib.py', content: 'VALUE = 1\n' }],
      main: 'print("hello")\n',
    });
    board.attach(session);
    boot(board);

    expect(board.console).toContain('MicroPython v1.28.0');
    expect(board.console).not.toContain('_vf.write');
    expect(board.console).not.toContain('\x04');
    // Not a fragment of it either: the handshake banner is matched mid-word,
    // and showing up to the match left a truncated 'raw REP' in the monitor.
    expect(board.console).not.toContain('raw REP');
    // Nor the prompt + OK the board answers the statement that starts it with.
    expect(board.console).not.toContain('>OK');
    // Program output, once it is the program talking, goes straight through.
    board.say('hello\r\n');
    expect(board.console.endsWith('hello\r\n')).toBe(true);
  });

  it('still delivers a file whose path alone overflows one burst', () => {
    // The `open` line carries the path verbatim, so a deep enough path cannot
    // fit the burst. It must split rather than corrupt the stream.
    const deep = 'lib/vendor/drivers/display/controllers/ssd1306_variant_b.py';
    expect(deep.length).toBeGreaterThan(48);
    const board = new FakeBoard();
    const session = new MicroPythonSession((b) => board.receive(b), {
      files: [{ name: deep, content: 'ID = 0x3c\n' }],
      main: 'print("up")\n',
    });
    board.attach(session);
    boot(board);

    expect(session.state).toBe('running');
    expect(textOf(board.fs.get(deep))).toBe('ID = 0x3c\n');
    expect(Math.max(...board.bursts)).toBeLessThanOrEqual(BURST);
  });

  it('reports a board-side failure instead of starting the program', () => {
    const board = new FakeBoard();
    board.failOnStep = 3; // partway through writing the library
    const notices: string[] = [];
    let failure: string | null = null;
    const session = new MicroPythonSession(
      (b) => board.receive(b),
      { files: [{ name: 'lib.py', content: 'VALUE = 1\n' }], main: 'print("x")\n' },
      { onNotice: (l) => notices.push(l), onFailed: (r) => (failure = r) },
    );
    board.attach(session);
    boot(board);

    // Silently running a program whose library never arrived is the one
    // outcome worse than the MemoryError: the user gets an ImportError from a
    // line they did write, and no clue why.
    expect(session.state).toBe('failed');
    expect(board.ran).toBeNull();
    expect(failure).toContain('OSError: 28');
    expect(notices.join('')).toContain('could not load the project');
  });
});
