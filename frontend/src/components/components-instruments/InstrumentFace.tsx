/**
 * Shared chrome for the SPICE probe instruments (voltmeter / ammeter).
 *
 * Drawn as inline SVG rather than nested divs so the bezel, the recessed
 * screen and the terminal lugs stay crisp at any canvas zoom.
 *
 * GEOMETRY IS LOAD-BEARING. `InstrumentComponent` publishes fixed pinInfo
 * coordinates for the wire router, measured from the wrapper's top-left:
 *
 *   voltmeter  V+ (4, 24)   V- (4, 48)
 *   ammeter    A+ (4, 36)   A- (118, 36)
 *
 * The wrapper adds a 2px border + 4px padding, so this face's own origin sits
 * at (6, 6) and the body must stay 110 wide with terminals centred on
 * y = 18 / 42 (voltmeter) and y = 30 (ammeter). Those y values must NOT move
 * when the body grows for the AC readout, so the screen grows downward only.
 */
import { useId, type ReactNode } from 'react';

export const INSTRUMENT_WIDTH = 110;

export interface InstrumentTerminal {
  /** Label drawn beside the lug. */
  label: string;
  /** Vertical centre, in face coordinates. */
  y: number;
  /** Which edge the lug protrudes from. */
  side: 'left' | 'right';
  /** Red for the "+" lead, graphite for the return, as on a bench meter. */
  polarity: 'plus' | 'minus';
}

interface InstrumentFaceProps {
  /** Total body height — 60 for a single DC line, 78 with the AC sub-lines. */
  height: number;
  /** Instrument tint, used for the digits and the live indicator. */
  accent: string;
  /** Corner legend, e.g. "DC V" / "AC A". */
  legend: string;
  /** Dimmed when the last solve did not converge. */
  stale: boolean;
  terminals: InstrumentTerminal[];
  /** Screen content, positioned by the caller inside the screen rect. */
  children: ReactNode;
}

const LUG_W = 7;
const LUG_H = 12;

export function InstrumentFace({
  height,
  accent,
  legend,
  stale,
  terminals,
  children,
}: InstrumentFaceProps) {
  const clipId = `instr-screen-${useId().replace(/:/g, '')}`;
  const screenTop = 19;
  const screenHeight = height - screenTop - 7;
  return (
    <svg
      width={INSTRUMENT_WIDTH}
      height={height}
      viewBox={`0 0 ${INSTRUMENT_WIDTH} ${height}`}
      // Terminal lugs deliberately paint outside the viewBox, level with the
      // pin coordinates above, so the wire visually lands on metal.
      style={{ overflow: 'visible', display: 'block' }}
    >
      <defs>
        <linearGradient id={`instr-body-${accent.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b3037" />
          <stop offset="1" stopColor="#1c2025" />
        </linearGradient>
      </defs>

      {/* Lugs sit under the body so the bezel overlaps their inner edge. The
          polarity glyph is printed on the lug itself, the way a bench meter
          marks its binding posts: inside the body it would fight the screen. */}
      {terminals.map((term) => {
        const lugX = term.side === 'left' ? -LUG_W + 1 : INSTRUMENT_WIDTH - 1;
        return (
          <g key={term.label}>
            <rect
              x={lugX}
              y={term.y - LUG_H / 2}
              width={LUG_W}
              height={LUG_H}
              rx={2}
              fill={term.polarity === 'plus' ? '#c0392b' : '#4b5158'}
              stroke="#14181c"
              strokeWidth={1}
            />
            <text
              x={lugX + LUG_W / 2 - (term.side === 'left' ? 1 : -1)}
              y={term.y + 3}
              textAnchor="middle"
              fontFamily="monospace"
              fontSize={9}
              fontWeight={700}
              fill="#e8eaed"
            >
              {term.label}
            </text>
          </g>
        );
      })}

      <rect
        x={0.5}
        y={0.5}
        width={INSTRUMENT_WIDTH - 1}
        height={height - 1}
        rx={7}
        fill={`url(#instr-body-${accent.slice(1)})`}
        stroke="#3b424a"
        strokeWidth={1}
      />

      <text x={9} y={13} fontFamily="monospace" fontSize={8} letterSpacing={1.4} fill="#8d959d">
        {legend}
      </text>
      {/* Live indicator: lit while the solve converged, dark when stale. */}
      <circle
        cx={INSTRUMENT_WIDTH - 11}
        cy={10}
        r={3}
        fill={stale ? '#3b424a' : accent}
        opacity={stale ? 1 : 0.9}
      />

      <rect
        x={7}
        y={screenTop}
        width={INSTRUMENT_WIDTH - 14}
        height={screenHeight}
        rx={4}
        fill="#0c1013"
        stroke="#2a3138"
        strokeWidth={1}
      />
      {/* Clip the readout: an over-long string ("- probe not connected") must
          stay inside the screen instead of spilling across the canvas. */}
      <clipPath id={clipId}>
        <rect x={7} y={screenTop} width={INSTRUMENT_WIDTH - 14} height={screenHeight} rx={4} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>{children}</g>
    </svg>
  );
}
