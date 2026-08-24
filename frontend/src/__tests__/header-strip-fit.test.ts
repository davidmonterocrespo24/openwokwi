/**
 * Where the editor toolbar strip goes: on the header's brand row or on its
 * own bar below, labelled or icon-only.
 *
 * The complaint this fixes: with the AI chat docked at 1440px, a board with
 * many canvas controls (XIAO: display + camera + mic + scope) wrapped the
 * strip INSIDE the header — canvas controls orphaned on a second line next
 * to a black hole — because the drop-below fallback and the label collapse
 * fired on guessed thresholds instead of the strip's real width. These
 * lock the rule: measured needed width vs measured available width, one
 * row preferred over two, labels preferred over icons.
 */
import { describe, it, expect } from 'vitest';
import {
  decideStripLayout,
  stripAvailableBelow,
  stripAvailableInline,
  stripNeededWidth,
} from '../components/layout/headerStripFit';

const base = {
  contentWidth: 1044, // 1440 minus 16px header padding minus 380px docked chat
  leftWidth: 352, // brand + File/Edit/View/Account/Help
  hostMarginXInline: 20, // .header-editor-toolbar { margin: 0 10px }
  hostMarginXBelow: -32, // own bar bleeds into the header padding
  stripPaddingX: 6, // in-header strip pads 6px right
};

// Zone widths per candidate layout: [view-mode toggle, editor zone, canvas
// controls]. On the narrow brand row the toggle is hidden by its own
// container query (0); on the wide own-bar it shows (139).
const uno = {
  inlineZoneWidths: [0, 382, 268],
  inlineCompactZoneWidths: [0, 350, 240],
  belowZoneWidths: [139, 395, 268],
};
// Display + camera + mic + scope + add: ~640px of labelled canvas controls,
// ~344px icon-only; the editor zone carries "Libraries" (~530 / ~420).
const xiao = {
  inlineZoneWidths: [0, 530, 640],
  inlineCompactZoneWidths: [0, 420, 344],
  belowZoneWidths: [139, 530, 640],
};

describe('header strip layout', () => {
  it('sums the zones plus the strip padding; available subtracts brand + margins', () => {
    const i = { ...base, ...uno };
    expect(stripNeededWidth(i, 'inline')).toBe(656);
    expect(stripNeededWidth(i, 'inline-compact')).toBe(596);
    expect(stripNeededWidth(i, 'below')).toBe(808);
    expect(stripAvailableInline(i)).toBe(672);
    expect(stripAvailableBelow(i)).toBe(1076);
  });

  it('keeps an Uno-sized strip labelled on the brand row at 1440 with the chat docked', () => {
    expect(decideStripLayout({ ...base, ...uno })).toEqual({ below: false, compact: false });
  });

  it('goes icon-only on the brand row before dropping below', () => {
    // 1300px window with the chat: 904 content, 532 for the strip.
    const i = { ...base, contentWidth: 904, ...uno };
    expect(stripAvailableInline(i)).toBe(532);
    // labelled 656 does not fit, compact 596 does not either -> below
    expect(decideStripLayout(i)).toEqual({ below: true, compact: false });
    // a slightly narrower compact strip fits inline -> one row, icons
    expect(decideStripLayout({ ...i, inlineCompactZoneWidths: [0, 300, 220] })).toEqual({
      below: false,
      compact: true,
    });
  });

  it('drops a XIAO-sized strip below AND compacts it when the full bar cannot hold the labels', () => {
    // 1440 with the chat: 1076px bar, 1315px labelled on that bar -> compact.
    expect(decideStripLayout({ ...base, ...xiao })).toEqual({ below: true, compact: true });
    // The same board on a 1920 window with the chat: 1524 content ->
    // 1152 inline (labels 1176 no, compact 770 yes) -> one row, icons.
    expect(decideStripLayout({ ...base, contentWidth: 1524, ...xiao })).toEqual({
      below: false,
      compact: true,
    });
  });

  it('judges the own-bar by the widths the strip has THERE (the view toggle reappears)', () => {
    // 1300 with the chat: 532 inline (no), 936 own-bar; measured on the brand
    // row the strip would seem to fit the bar (656 <= 936) — but there the
    // hidden view-mode toggle comes back and the bar wraps in two.
    const i = { ...base, contentWidth: 904, ...uno, belowZoneWidths: [139, 530, 268] };
    expect(decideStripLayout(i)).toEqual({ below: true, compact: true });
  });

  it('is decided by the real widths, not a viewport threshold', () => {
    // 1000px window without the chat: the old media query forced two rows
    // below 1040px; a strip whose labels fit stays on one row.
    const noChat = { ...base, contentWidth: 968 };
    expect(
      decideStripLayout({
        ...noChat,
        inlineZoneWidths: [0, 322, 268],
        inlineCompactZoneWidths: [0, 300, 240],
        belowZoneWidths: [139, 395, 268],
      }),
    ).toEqual({ below: false, compact: false });
  });

  it('treats an exact fit as fitting', () => {
    expect(decideStripLayout({ ...base, ...uno, inlineZoneWidths: [0, 398, 268] })).toEqual({
      below: false,
      compact: false,
    });
  });
});
