import { useEffect, useRef } from 'react';
import boardSvg from '../../assets/Raspberry_Pi_2_illustration.svg';
import { buildPi40PinHeader } from './pi40PinHeader';

/**
 * Raspberry Pi 2 Model B — Velxio board art.
 *
 * Shares the 85 x 56 mm "B+ form factor" with the Pi 3, which is why this
 * board used to be drawn AS a Pi 3. The outline and the connector positions
 * really are identical; the silicon is not — BCM2836, the first quad-core, with its RAM moved to the underside — and neither is the
 * silkscreen, so the picture now says which board the student is holding.
 *
 * Geometry is in the SVG's own units (10 per mm), the same numbers the art is
 * drawn from, so the pin tips land on the drawn pads. Pitch is a true 2.54 mm.
 */

const SVG_VB_W = 884;   // 85 mm of PCB + the USB/Ethernet overhang on the right
const SVG_VB_H = 578;   // 56 mm of PCB + the connector overhang at the bottom
const HDR_X0 = 72;
const HDR_STEP = 25.4;
const HDR_Y_TOP = 42;
const HDR_Y_BOT = 67.4;

const DISPLAY_W = 330;
const SCALE = DISPLAY_W / SVG_VB_W;
const DISPLAY_H = Math.round(SVG_VB_H * SCALE);

interface Props {
  id?: string;
  x?: number;
  y?: number;
}

export const RaspberryPi2 = ({ id = 'raspberry-pi-2', x = 0, y = 0 }: Props) => {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (imgRef.current) {
      (imgRef.current as unknown as { pinInfo: unknown }).pinInfo = buildPi40PinHeader({
        xStart: HDR_X0 * SCALE,
        xStep: HDR_STEP * SCALE,
        yTop: HDR_Y_TOP * SCALE,
        yBot: HDR_Y_BOT * SCALE,
      });
    }
  }, []);

  return (
    <img
      ref={imgRef}
      id={id}
      src={boardSvg}
      alt="Raspberry Pi 2 Model B"
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        width: `${DISPLAY_W}px`,
        height: `${DISPLAY_H}px`,
        display: 'block',
        userSelect: 'none',
        pointerEvents: 'none',
      }}
    />
  );
};
