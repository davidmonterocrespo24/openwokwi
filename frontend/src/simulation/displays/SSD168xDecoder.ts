/**
 * SSD168xDecoder — TypeScript port of the reference SSD168x SPI decoder.
 *
 * Source spec / golden file: `test/test_epaper/ssd168x_decoder.py`. This
 * port is byte-for-byte algorithmically identical so the cross-decoder
 * consistency test (`ssd168x-decoder.test.ts`) can replay the same
 * fixtures through both implementations and assert the same framebuffers.
 *
 * Supports the entire Solomon Systech SSD168x family used by every
 * 1.54"–7.5" ePaper panel in our Phase-1 catalog (SSD1681, SSD1675A,
 * SSD1680, SSD1683). They share ~95 % of the command set; differences
 * are RAM size and which driver-output config bytes are accepted, both
 * orthogonal to this decoder.
 *
 * References:
 *   - SSD1681 datasheet (Adafruit mirror):
 *     https://cdn-learn.adafruit.com/assets/assets/000/099/573/original/SSD1681.pdf
 *   - ESP-BSP command header:
 *     https://github.com/espressif/esp-bsp/blob/master/components/lcd/esp_lcd_ssd1681/esp_lcd_ssd1681_commands.h
 */

// ── Command opcodes (shared across SSD168x family) ───────────────────────────

export const CMD_DRIVER_OUTPUT_CTRL    = 0x01;
export const CMD_GATE_DRIVING_VOLTAGE  = 0x03;
export const CMD_SOURCE_DRIVING_VOLT   = 0x04;
export const CMD_DEEP_SLEEP            = 0x10;
export const CMD_DATA_ENTRY_MODE       = 0x11;
export const CMD_SW_RESET              = 0x12;
export const CMD_TEMP_SENSOR           = 0x18;
export const CMD_MASTER_ACTIVATION     = 0x20;
export const CMD_DISP_UPDATE_CTRL_1    = 0x21;
export const CMD_DISP_UPDATE_CTRL_2    = 0x22;
export const CMD_WRITE_BLACK_VRAM      = 0x24;
export const CMD_WRITE_RED_VRAM        = 0x26;
export const CMD_WRITE_VCOM_REG        = 0x2c;
export const CMD_WRITE_LUT             = 0x32;
export const CMD_BORDER_WAVEFORM       = 0x3c;
export const CMD_END_OPTION            = 0x3f;
export const CMD_SET_RAMX_RANGE        = 0x44;
export const CMD_SET_RAMY_RANGE        = 0x45;
export const CMD_SET_RAMX_COUNTER      = 0x4e;
export const CMD_SET_RAMY_COUNTER      = 0x4f;

// Palette indices used in the composed frame: 0 = black, 1 = white,
// 2 = red (only when the red RAM plane was written).
export type EPaperPalette = 0 | 1 | 2;

export interface Frame {
  width: number;
  height: number;
  /**
   * width*height palette indices (0 = black, 1 = white, 2 = red). Always
   * present. For a 4-level greyscale frame this is a 1-bit projection of
   * `grey` (level 0/1 -> black, level 2/3 -> white) so 1-bit/BWR consumers
   * keep working unchanged.
   */
  pixels: Uint8Array;
  /**
   * OPTIONAL 4-level greyscale channel. Present ONLY when the stream was
   * detected as 2-bits-per-pixel greyscale (a custom waveform LUT via 0x32
   * AND both RAM planes written): width*height values 0..3 where 0 = black,
   * 3 = white, 1/2 = the two intermediate greys. Absent for every 1-bit /
   * tri-colour panel, so consumers that only read `pixels` are unaffected.
   */
  grey?: Uint8Array;
}

/**
 * Maps the 2-bit plane combo -> grey level 0..3 for greyscale mode. The
 * combo index is (bwBit << 1) | redBit, where bwBit is the 0x24 (WRITE_RAM_BW)
 * plane bit and redBit is the 0x26 (WRITE_RAM_RED) plane bit at that pixel.
 * Level 0 = black, 3 = white.
 *
 * The bwBit (0x24) is the dominant luminance bit — bwBit=0 selects the LIGHT
 * pair {white, light-grey}, bwBit=1 the DARK pair {dark-grey, black}; this is
 * the same polarity as the custom-waveform 1-bit path (white where 0x24 bit=0),
 * so the 1-bit projection of a greyscale frame is byte-identical to the legacy
 * render. The redBit (0x26) refines within each half — set = one step darker.
 * Verified empirically against a captured SSD1680 2.7" greyscale (picovector,
 * antialiased) menu render: combo 0 (both clear) is the white page background,
 * and this ordering yields smooth icon greys rather than speckle. Overridable
 * via SSD168xDecoderOptions.greyComboToLevel for a LUT that reorders the pair.
 */
export const DEFAULT_GREY_COMBO_TO_LEVEL: Readonly<[number, number, number, number]> = [
  3, // combo 0: bw=0 red=0 -> white
  2, // combo 1: bw=0 red=1 -> light grey
  1, // combo 2: bw=1 red=0 -> dark grey
  0, // combo 3: bw=1 red=1 -> black
];

export interface SSD168xDecoderOptions {
  width: number;
  height: number;
  /**
   * Visible palette. 'bwr' = tri-colour (0x26 is the additive red plane,
   * red wins on compose). 'bw' (default) = mono; some controllers (e.g.
   * GDEY029T94) mirror the image into the 0x26 plane, so a B/W panel is
   * white only where BOTH planes say white. 'acep' is handled elsewhere.
   */
  palette?: 'bw' | 'bwr' | 'acep';
  /** Fired on every 0x20 MASTER_ACTIVATION with the latched composed frame. */
  onFlush?: (frame: Frame) => void;
  /**
   * Optional override of the 2-bit-combo -> grey-level map used in greyscale
   * mode (see DEFAULT_GREY_COMBO_TO_LEVEL). Only tunes the level ordering; it
   * does NOT force greyscale on — that is auto-detected from the stream.
   */
  greyComboToLevel?: Readonly<[number, number, number, number]>;
}

/**
 * Single-instance state machine. **Not thread-safe** — re-use only via the
 * (single-threaded) JS event loop.
 */
export class SSD168xDecoder {
  readonly width: number;
  readonly height: number;
  /** True for tri-colour B/W/Red panels. */
  private readonly isBwr: boolean;
  /**
   * RAM geometry — sized to the LONGER side both ways so a rotated native
   * layout (a 296x128 landscape panel whose controller RAM is 128x296) is
   * captured without dropping rows. composeFrame() reads back the active
   * window and rotates to the display orientation.
   */
  private readonly ramBpr: number;
  private readonly ramRows: number;

  /** B/W RAM plane. 1 bit = 1 px. Bit value 1 = white, 0 = black. */
  bwRam: Uint8Array;
  /** Red RAM plane. 1 bit = 1 px. Bit value 1 = red, 0 = transparent. */
  redRam: Uint8Array;

  private currentCmd = -1;
  private params: number[] = [];

  /** Current X position in bytes (1 byte = 8 px). */
  private xByte = 0;
  /** Current Y position (scanline). */
  private y = 0;

  /** Active RAM window in bytes (start, end inclusive) — the LAST one set,
   *  used for the write cursor's auto-increment. */
  private xrange: [number, number] = [0, 0];
  /** Active RAM window in scanlines (start, end inclusive) — last one set. */
  private yrange: [number, number] = [0, 0];

  /** UNION of every RAM window set since the last flush — paged drivers
   *  (GxEPD2 page height < panel) set one partial window per page, so compose
   *  must use the union (full native area), not just the last page's strip. */
  private winX0 = 0;
  private winX1 = 0;
  private winY0 = 0;
  private winY1 = 0;
  private winXSet = false;
  private winYSet = false;

  /** Data-entry-mode register (0x11). Default = 0x03 (X+, Y+, X-first). */
  private entryMode = 0x03;

  /**
   * True once the host uploaded its own B/W waveform LUT via 0x32 (WRITE_LUT)
   * instead of loading the OTP/built-in waveform (0x22 with the load-LUT bit
   * 0x10, e.g. 0xF7). A custom waveform redefines the generic SSD168x B/W
   * convention: on the OTP/built-in waveform RAM bit 1 = white, but a
   * custom-waveform panel in our catalog inverts it (bit 1 = black). This is
   * auto-detected from the command stream — the decoder never keys off a panel
   * name. Every standard SSD168x path we drive (GxEPD2 full refresh, the raw
   * SSD1680 badge examples) loads the OTP LUT and never sends 0x32, so this
   * stays false for them and their polarity is unchanged.
   */
  private customBwLut = false;

  /**
   * True once the host wrote the 0x26 (WRITE_RAM_RED) plane since the last
   * flush/reset. On a standard mono panel 0x26 is never sent; on a tri-colour
   * panel it is the additive red plane; combined with customBwLut (a custom
   * 0x32 waveform) it signals the SECOND greyscale bit-plane of a 2-bpp
   * 4-level greyscale render. Reset per frame so a later 1-bit-only refresh
   * (0x24 alone) is not mis-detected as greyscale.
   */
  private redWritten = false;

  /** combo (bwBit<<1|redBit) -> grey level 0..3, for greyscale compose. */
  private readonly greyMap: Readonly<[number, number, number, number]>;

  /** Diagnostics: how many full refresh activations we've seen. */
  refreshedCount = 0;
  /** Diagnostics: opcodes the host emitted that aren't in our table. */
  unknownCmds: number[] = [];
  /** True when the chip has been put into deep sleep. */
  inDeepSleep = false;

  private readonly onFlush?: (frame: Frame) => void;

  constructor(opts: SSD168xDecoderOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.isBwr = opts.palette === 'bwr';
    const longSide = Math.max(opts.width, opts.height);
    this.ramBpr = (longSide + 7) >> 3;
    this.ramRows = longSide;
    this.onFlush = opts.onFlush;
    this.greyMap = opts.greyComboToLevel ?? DEFAULT_GREY_COMBO_TO_LEVEL;

    const size = this.ramBpr * this.ramRows;
    this.bwRam = new Uint8Array(size).fill(0xff); // default white
    // B/W panel: 0x26 is a second mono plane → init white. B/W/R panel:
    // 0x26 is the additive red plane → init "no red" (0x00).
    this.redRam = new Uint8Array(size).fill(this.isBwr ? 0x00 : 0xff);

    // Default active window = DISPLAY geometry (the firmware overrides via
    // 0x44/0x45 before writing). RAM is sized larger, but until a window is
    // set the panel is treated as un-rotated display-sized.
    this.xrange = [0, ((opts.width + 7) >> 3) - 1];
    this.yrange = [0, opts.height - 1];
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Process one SPI byte. `dcHigh` mirrors the DC pin (false = LOW = command).
   */
  feed(byte: number, dcHigh: boolean): void {
    if (!dcHigh) this.beginCommand(byte & 0xff);
    else this.handleData(byte & 0xff);
  }

  /** Clear all state — equivalent to a hardware RST low pulse. */
  reset(): void {
    this.bwRam.fill(0xff);
    this.redRam.fill(this.isBwr ? 0x00 : 0xff);
    this.currentCmd = -1;
    this.params = [];
    this.xByte = 0;
    this.y = 0;
    this.entryMode = 0x03;
    this.customBwLut = false;
    this.redWritten = false;
    this.xrange = [0, ((this.width + 7) >> 3) - 1];
    this.yrange = [0, this.height - 1];
    this.winXSet = false;
    this.winYSet = false;
    this.inDeepSleep = false;
  }

  /**
   * Build a Frame from the latched RAM planes.
   *
   * Compose in the controller's NATIVE geometry — the active RAM window the
   * firmware actually wrote (set via 0x44/0x45) — then rotate to the display
   * orientation. This handles panels driven with setRotation() whose native
   * RAM (e.g. 128x296) is the transpose of the display (296x128); composing
   * directly at the display dims would drop half the rows and never rotate.
   *
   * Composition: tri-colour → red wins, else B/W plane decides. B/W → white
   * only if BOTH planes say white (the image may live in 0x24 or 0x26).
   */
  composeFrame(): Frame {
    // Use the UNION of windows set this frame (paged drivers set one partial
    // window per page); fall back to the display geometry if none was set.
    // Normalize the window bounds with min/max: a RAM range can be supplied
    // descending (e.g. yrange=[263,0]) in an X-/Y-decrement entry mode. Taking
    // winX0/winY0 verbatim as the low bound then collapses nh to 0 (blank frame).
    const x0 = this.winXSet ? Math.min(this.winX0, this.winX1) : 0;
    const x1 = this.winXSet ? Math.max(this.winX0, this.winX1) : ((this.width + 7) >> 3) - 1;
    const y0 = this.winYSet ? Math.min(this.winY0, this.winY1) : 0;
    const y1 = this.winYSet ? Math.max(this.winY0, this.winY1) : this.height - 1;
    // Y-decrement entry mode (0x11 bit 1 clear) writes RAM from the high gate
    // address downward, so the visual top row is the HIGH RAM address. Standard
    // Y-increment panels keep the low address as the top.
    const yTopIsHigh = (this.entryMode & 0x02) === 0;
    // Inverted B/W polarity when the host uploaded a custom waveform LUT (0x32).
    const bwInvert = this.customBwLut;
    // 4-level greyscale: a custom waveform LUT (0x32) AND both RAM planes
    // written this frame means each pixel is 2 bits (0x24 = one bit-plane,
    // 0x26 = the other), composited by the custom LUT into 4 grey levels.
    // Auto-detected purely from the stream — no panel name involved.
    const greyscale = this.customBwLut && this.redWritten;
    const nwBytes = Math.max(0, x1 - x0 + 1);
    const nw = nwBytes * 8; // native width (px)
    const nh = Math.max(0, y1 - y0 + 1); // native height (rows)
    const native = new Uint8Array(nw * nh); // palette 0/1/2
    // Parallel greyscale plane (level 0..3), only allocated in greyscale mode.
    const nativeGrey = greyscale ? new Uint8Array(nw * nh) : null;
    for (let ny = 0; ny < nh; ny++) {
      const srcY = yTopIsHigh ? y1 - ny : y0 + ny;
      const row = srcY * this.ramBpr + x0;
      const outRow = ny * nw;
      for (let xb = 0; xb < nwBytes; xb++) {
        const bByte = this.bwRam[row + xb];
        const rByte = this.redRam[row + xb];
        const base = xb << 3;
        for (let bit = 0; bit < 8; bit++) {
          const x = base + bit;
          if (x >= nw) break;
          const mask = 0x80 >> bit;
          if (greyscale) {
            // Two raw plane bits -> combo -> grey level via the custom-LUT map.
            const bBit = (bByte & mask) !== 0 ? 1 : 0;
            const rBit = (rByte & mask) !== 0 ? 1 : 0;
            const level = this.greyMap[(bBit << 1) | rBit];
            nativeGrey![outRow + x] = level;
            // 1-bit projection for consumers that only read `pixels`:
            // dark levels (0,1) -> black, light levels (2,3) -> white.
            native[outRow + x] = level >= 2 ? 1 : 0;
            continue;
          }
          const bwWhite = ((bByte & mask) !== 0) !== bwInvert;
          if (this.isBwr) {
            native[outRow + x] = (rByte & mask) !== 0 ? 2 : bwWhite ? 1 : 0;
          } else if (bwInvert) {
            // Custom-waveform B/W panel: the image lives entirely in the 0x24
            // plane. The 0x26 plane here is the differential "old" framebuffer,
            // not a mirrored second mono plane, so it must not gate the result.
            native[outRow + x] = bwWhite ? 1 : 0;
          } else {
            native[outRow + x] = bwWhite && (rByte & mask) !== 0 ? 1 : 0;
          }
        }
      }
    }

    // Map a native-geometry array -> display geometry (handles the byte-padded
    // native width and the rotation-0 / rotation-1 transpose). Shared by the
    // palette plane and the greyscale plane so both rotate identically.
    const W = this.width;
    const H = this.height;
    const Wb = (W + 7) >> 3;
    const Hb = (H + 7) >> 3;
    const toDisplay = (src: Uint8Array, fill: number): Uint8Array => {
      if (nh === H && nwBytes === Wb) {
        // Non-transposed (rotation 0): native actual width = W.
        if (nw === W) return src;
        const out = new Uint8Array(W * H).fill(fill);
        for (let ny = 0; ny < H; ny++) {
          const s = ny * nw;
          const d = ny * W;
          for (let x = 0; x < W; x++) out[d + x] = src[s + x];
        }
        return out;
      } else if (nh === W && nwBytes === Hb && nh) {
        // Transposed (rotation 1): native actual width = H. Inverse of
        // Adafruit_GFX rotation 1: native(x_raw,y_raw) -> display(xd=y_raw,
        // yd=Wn-1-x_raw), Wn = true native width = H.
        //
        // Under a Y-decrement entry mode (BadgeOS) the source axis ends up
        // vertically flipped in the display versus the standard Y-increment
        // (GxEPD2 / raw-SSD1680) path this transpose was calibrated against, so
        // the whole image renders upside-down (its text reads flipped). Map the
        // source index straight to the display row for the Y-decrement case;
        // Y-increment panels keep the Wn-1-x mapping and are byte-for-byte
        // unchanged.
        const out = new Uint8Array(W * H).fill(fill);
        const Wn = H;
        for (let ny = 0; ny < nh; ny++) {
          if (ny >= W) break;
          const s = ny * nw;
          for (let x = 0; x < Wn; x++) {
            const dispRow = yTopIsHigh ? x : Wn - 1 - x;
            out[dispRow * W + ny] = src[s + x];
          }
        }
        return out;
      }
      // Unexpected geometry — best-effort top-left copy onto the fill colour.
      const out = new Uint8Array(W * H).fill(fill);
      for (let ny = 0; ny < Math.min(nh, H); ny++) {
        const s = ny * nw;
        const d = ny * W;
        for (let x = 0; x < Math.min(nw, W); x++) out[d + x] = src[s + x];
      }
      return out;
    };

    const pixels = toDisplay(native, 1); // 1 = white padding
    if (nativeGrey) {
      const grey = toDisplay(nativeGrey, 3); // 3 = white padding
      return { width: W, height: H, pixels, grey };
    }
    return { width: W, height: H, pixels };
  }

  // ── Internal: command / data dispatch ──────────────────────────────

  private beginCommand(cmd: number): void {
    this.currentCmd = cmd;
    this.params = [];

    switch (cmd) {
      case CMD_SW_RESET:
        this.reset();
        return;
      case CMD_MASTER_ACTIVATION: {
        this.refreshedCount += 1;
        const frame = this.composeFrame();
        this.onFlush?.(frame);
        // Do NOT reset the window union or the greyscale flag here. e-paper RAM
        // persists between refreshes: a PARTIAL refresh (BadgeOS redraws only a
        // strip on navigation) sets a small window, and resetting the union made
        // composeFrame emit just that strip — placed top-left with the rest
        // black, which reads as a 90°-rotated screen with a black band. Keeping
        // the union means it stays at the full-panel extent established by the
        // first full refresh, so every frame composes the whole persistent RAM
        // and partial updates land in place. Paged full refreshes (GxEPD2) still
        // re-cover the full panel each frame, so their union is unchanged. Both
        // are cleared only by a real RST (0x12 -> reset()).
        return;
      }
      // WRITE_BLACK/RED are recognized no-ops here; handleData() routes their
      // data bytes to the correct plane by the current opcode.
      case CMD_WRITE_BLACK_VRAM:
      case CMD_WRITE_RED_VRAM:
      case CMD_DRIVER_OUTPUT_CTRL:
      case CMD_GATE_DRIVING_VOLTAGE:
      case CMD_SOURCE_DRIVING_VOLT:
      case CMD_DEEP_SLEEP:
      case CMD_DATA_ENTRY_MODE:
      case CMD_TEMP_SENSOR:
      case CMD_DISP_UPDATE_CTRL_1:
      case CMD_DISP_UPDATE_CTRL_2:
      case CMD_WRITE_VCOM_REG:
      case CMD_WRITE_LUT:
      case CMD_BORDER_WAVEFORM:
      case CMD_END_OPTION:
      case CMD_SET_RAMX_RANGE:
      case CMD_SET_RAMY_RANGE:
      case CMD_SET_RAMX_COUNTER:
      case CMD_SET_RAMY_COUNTER:
        return;
      default:
        // Unknown opcode — log so users can report panel quirks, but never
        // throw. Real-world firmware sometimes emits vendor-specific bytes.
        this.unknownCmds.push(cmd);
    }
  }

  private handleData(byte: number): void {
    const cmd = this.currentCmd;
    this.params.push(byte);
    const params = this.params;

    if (cmd === CMD_DEEP_SLEEP && params.length === 1) {
      this.inDeepSleep = byte !== 0;
    } else if (cmd === CMD_DATA_ENTRY_MODE && params.length === 1) {
      this.entryMode = byte;
    } else if (cmd === CMD_SET_RAMX_RANGE && params.length === 2) {
      this.xrange = [params[0], params[1]];
      this.xByte = params[0];
      if (!this.winXSet) {
        this.winX0 = params[0];
        this.winX1 = params[1];
        this.winXSet = true;
      } else {
        this.winX0 = Math.min(this.winX0, params[0]);
        this.winX1 = Math.max(this.winX1, params[1]);
      }
    } else if (cmd === CMD_SET_RAMY_RANGE && params.length === 4) {
      this.yrange = [
        params[0] | (params[1] << 8),
        params[2] | (params[3] << 8),
      ];
      this.y = this.yrange[0];
      if (!this.winYSet) {
        this.winY0 = this.yrange[0];
        this.winY1 = this.yrange[1];
        this.winYSet = true;
      } else {
        this.winY0 = Math.min(this.winY0, this.yrange[0]);
        this.winY1 = Math.max(this.winY1, this.yrange[1]);
      }
    } else if (cmd === CMD_SET_RAMX_COUNTER && params.length === 1) {
      this.xByte = byte;
    } else if (cmd === CMD_SET_RAMY_COUNTER && params.length === 2) {
      this.y = params[0] | (params[1] << 8);
    } else if (cmd === CMD_WRITE_BLACK_VRAM) {
      this.writeRamByte(this.bwRam, byte);
    } else if (cmd === CMD_WRITE_RED_VRAM) {
      this.redWritten = true;
      this.writeRamByte(this.redRam, byte);
    } else if (cmd === CMD_WRITE_LUT) {
      // The host uploaded its own B/W waveform LUT (write_luts()) rather than
      // loading the OTP/built-in waveform. This replaces the generic bit-1=white
      // mapping — see customBwLut / composeFrame(). Idempotent across the LUT's
      // bytes. A preceding 0x12/RST reset clears the flag, and firmware sends
      // the custom LUT after reset during init, so the flag reflects the panel.
      this.customBwLut = true;
    }
    // Other commands silently buffer their parameters.
  }

  private writeRamByte(plane: Uint8Array, byte: number): void {
    const bpr = this.ramBpr;
    if (
      this.xByte >= 0 &&
      this.xByte < bpr &&
      this.y >= 0 &&
      this.y < this.ramRows
    ) {
      plane[this.y * bpr + this.xByte] = byte;
    }
    // Auto-increment per data_entry_mode (default 0x03: X+, then Y+ at end of row).
    const xInc = (this.entryMode & 0x01) === 0x01;
    const yInc = (this.entryMode & 0x02) === 0x02;
    // A range may be supplied DESCENDING (start > end) in an X-/Y-decrement
    // entry mode — e.g. yrange=[263,0] means "start at 263, count down to 0".
    // Wrap the counters between the TRUE min/max of each range; using the
    // positional [0]/[1] as if ascending collapses every scanline onto one RAM
    // row (the garbled / near-blank frame). For an ascending range xLo/yLo ==
    // range[0] and xHi/yHi == range[1], so standard panels are unaffected.
    const xLo = Math.min(this.xrange[0], this.xrange[1]);
    const xHi = Math.max(this.xrange[0], this.xrange[1]);
    const yLo = Math.min(this.yrange[0], this.yrange[1]);
    const yHi = Math.max(this.yrange[0], this.yrange[1]);
    let endOfRow = false;
    if (xInc) {
      if (this.xByte < xHi) this.xByte += 1;
      else { this.xByte = xLo; endOfRow = true; }
    } else {
      if (this.xByte > xLo) this.xByte -= 1;
      else { this.xByte = xHi; endOfRow = true; }
    }
    if (endOfRow) {
      // Advance Y, WRAPPING at the window boundary like the SSD168x RAM address
      // counter. Some drivers (e.g. GxEPD2_3C) write the 0x24 then the 0x26
      // plane without re-seeking the counter, relying on this wrap so the
      // second plane lands in the window.
      if (yInc) this.y = this.y < yHi ? this.y + 1 : yLo;
      else this.y = this.y > yLo ? this.y - 1 : yHi;
    }
  }
}
