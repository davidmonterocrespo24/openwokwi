/**
 * The readout inside an InstrumentFace: one big line for DC, or RMS over a
 * peak/DC sub-line when the probed signal has AC content (bench-DMM layout).
 */
import type { ProbeReading } from '../../simulation/spice/probes';
import { INSTRUMENT_WIDTH } from './InstrumentFace';

const CENTER = INSTRUMENT_WIDTH / 2;
/** Usable width inside the screen bezel, minus a little breathing room. */
const SCREEN_TEXT_WIDTH = INSTRUMENT_WIDTH - 20;
/** Advance width of one monospace glyph as a fraction of the font size. */
const GLYPH_RATIO = 0.62;

/**
 * Shrink the digits so a long string still fits the screen. Readings are
 * normally short ("3.437 V"), but the not-connected and RMS strings are two
 * to three times that, and at a fixed size they ran off the instrument.
 */
function fitFontSize(text: string, preferred: number): number {
  const max = SCREEN_TEXT_WIDTH / (GLYPH_RATIO * Math.max(text.length, 1));
  return Math.max(6.5, Math.min(preferred, max));
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function InstrumentScreen({ reading, accent }: { reading: ProbeReading; accent: string }) {
  const digits = reading.stale ? '#5c646c' : accent;
  if (!reading.ac) {
    return (
      <text
        x={CENTER}
        y={42}
        textAnchor="middle"
        fontFamily={MONO}
        fontSize={fitFontSize(reading.display, 15)}
        fontWeight={700}
        fill={digits}
      >
        {reading.display}
      </text>
    );
  }
  // The peak and DC legends share one line from opposite edges, so they are
  // sized against their COMBINED length plus a gap, not individually.
  const subLen = reading.ac.peakDisplay.length + reading.ac.dcDisplay.length;
  const sub = Math.max(6, Math.min(7.5, (SCREEN_TEXT_WIDTH - 10) / (GLYPH_RATIO * subLen)));
  return (
    <>
      <text
        x={CENTER}
        y={40}
        textAnchor="middle"
        fontFamily={MONO}
        fontSize={fitFontSize(reading.ac.rmsDisplay, 14)}
        fontWeight={700}
        fill={digits}
      >
        {reading.ac.rmsDisplay}
      </text>
      <text x={11} y={58} fontFamily={MONO} fontSize={sub} fill={digits} opacity={0.75}>
        {reading.ac.peakDisplay}
      </text>
      <text
        x={INSTRUMENT_WIDTH - 11}
        y={58}
        textAnchor="end"
        fontFamily={MONO}
        fontSize={sub}
        fill={digits}
        opacity={0.75}
      >
        {reading.ac.dcDisplay}
      </text>
    </>
  );
}
