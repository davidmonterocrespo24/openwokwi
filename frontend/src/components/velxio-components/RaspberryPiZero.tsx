import { useEffect, useRef } from 'react';
import raspberryPiZeroSvg from '../../assets/Raspberry_Pi_Zero_illustration.svg';
import { buildPi40PinHeader } from './pi40PinHeader';

/**
 * Raspberry Pi Zero 2 W — Velxio board art.
 *
 * The Zero used to borrow the Pi 3's picture. That is wrong in the one way a
 * board picture can be wrong: it is a different SIZE. The Zero is 65 x 30 mm
 * against the Pi 3's 85 x 56 mm, its header ships unpopulated, and it has no
 * Ethernet and no full-size USB. A canvas that draws it as a Pi 3 tells the
 * student the opposite of what the hardware looks like.
 *
 * Geometry below is in the SVG's own units (10 per mm) and is the SAME set of
 * numbers the artwork is drawn from, so the pin tips cannot drift off the
 * pads. Header pitch is a true 2.54 mm.
 */

const SVG_W = 650;      // 65 mm
const SVG_VB_H = 314;   // 30 mm of PCB + the connector overhang at the bottom
const HDR_X0 = 82;
const HDR_STEP = 25.4;
const HDR_Y_TOP = 31;
const HDR_Y_BOT = 56.4;

// 65 mm next to the Pi 3's 85 mm at 320 px: 320 * 65 / 85 ~ 245. Round to 250
// so the Zero reads as the small board it is when both sit on one canvas.
const DISPLAY_W = 250;
const SCALE = DISPLAY_W / SVG_W;
const DISPLAY_H = Math.round(SVG_VB_H * SCALE);

interface RaspberryPiZeroProps {
  id?: string;
  x?: number;
  y?: number;
}

export const RaspberryPiZero = ({
  id = 'raspberry-pi-zero',
  x = 0,
  y = 0,
}: RaspberryPiZeroProps) => {
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
      src={raspberryPiZeroSvg}
      alt="Raspberry Pi Zero 2 W"
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
