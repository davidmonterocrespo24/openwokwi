/**
 * The tilt pad's gravity maths, on its own.
 *
 * What a user aims with the pad is an attitude; what the IMU model wants is
 * the gravity vector in the board's frame. Getting the mapping wrong is the
 * kind of bug that looks fine on screen — the dot moves, numbers change — and
 * only shows up as a sketch tilting the wrong way, so it is pinned here rather
 * than left to the eye.
 */
import { describe, expect, it } from 'vitest';
import { gravityFor } from '../components/simulator/BoardSensorControls';

/** Length of the vector: gravity is 1 g however the board is held. */
const magnitude = ([x, y, z]: [number, number, number]) => Math.sqrt(x * x + y * y + z * z);

describe('tilt pad gravity', () => {
  it('reads flat on a table as +1 g on Z', () => {
    const [x, y, z] = gravityFor(0, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(1, 6);
  });

  it('stays at 1 g whatever the attitude', () => {
    for (const roll of [-80, -37, 0, 12, 80]) {
      for (const pitch of [-80, -5, 0, 45, 80]) {
        expect(magnitude(gravityFor(roll, pitch))).toBeCloseTo(1, 6);
      }
    }
  });

  it('rolls onto -X and pitches onto +Y', () => {
    const rolled = gravityFor(90, 0);
    expect(rolled[0]).toBeCloseTo(-1, 6);
    expect(rolled[2]).toBeCloseTo(0, 6);

    const pitched = gravityFor(0, 90);
    expect(pitched[1]).toBeCloseTo(1, 6);
    expect(pitched[2]).toBeCloseTo(0, 6);
  });

  it('mirrors opposite tilts', () => {
    const [lx, ly, lz] = gravityFor(-30, -20);
    const [rx, ry, rz] = gravityFor(30, 20);
    expect(lx).toBeCloseTo(-rx, 6);
    expect(ly).toBeCloseTo(-ry, 6);
    expect(lz).toBeCloseTo(rz, 6); // Z is even in both angles
  });
});
