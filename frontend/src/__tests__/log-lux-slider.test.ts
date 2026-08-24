/**
 * Log-scale illumination sliders.
 *
 * An LDR responds logarithmically, so on the old linear 0-1000 lux slider
 * the whole useful range of the night-light example sat in the first ~2% of
 * travel (its 500-count threshold crosses at ~20 lux). The slider now runs
 * in log position space; these pin the mapping and its round-trip.
 */
import { describe, it, expect } from 'vitest';
import {
  LOG_SLIDER_STEPS,
  logSliderToValue,
  logValueToSlider,
  SENSOR_CONTROLS,
} from '../simulation/sensorControlConfig';

describe('logSliderToValue', () => {
  it('anchors both ends exactly', () => {
    expect(logSliderToValue(0, 0, 1000)).toBe(0);
    expect(logSliderToValue(LOG_SLIDER_STEPS, 0, 1000)).toBe(1000);
  });

  it('gives the low decades real travel', () => {
    // ~20 lux (the night-light threshold) must sit well inside the track,
    // not at 2% like the linear map put it.
    const pos20 = logValueToSlider(20, 0, 1000);
    expect(pos20 / LOG_SLIDER_STEPS).toBeGreaterThan(0.3);
    expect(pos20 / LOG_SLIDER_STEPS).toBeLessThan(0.6);
    // Mid-travel lands in the tens of lux, not at 500.
    const mid = logSliderToValue(LOG_SLIDER_STEPS / 2, 0, 1000);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(100);
  });

  it('is monotonic and clamps out-of-range positions', () => {
    let prev = -1;
    for (let p = 0; p <= LOG_SLIDER_STEPS; p += 50) {
      const v = logSliderToValue(p, 0, 1000);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(logSliderToValue(-10, 0, 1000)).toBe(0);
    expect(logSliderToValue(LOG_SLIDER_STEPS + 10, 0, 1000)).toBe(1000);
  });

  it('round-trips within a step', () => {
    for (const v of [0, 1, 4, 20, 100, 500, 1000]) {
      const back = logSliderToValue(logValueToSlider(v, 0, 1000), 0, 1000);
      // log axis: resolution is relative, so allow 1% of the value (min 1)
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(1, v * 0.01));
    }
  });
});

describe('config wiring', () => {
  it('the illumination sliders are the log ones', () => {
    for (const id of ['photoresistor-sensor', 'photodiode']) {
      const lux = SENSOR_CONTROLS[id].controls.find(
        (c) => c.type === 'slider' && c.key === 'lux',
      );
      expect(lux && 'scale' in lux && lux.scale).toBe('log');
    }
  });
});
