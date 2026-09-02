// @vitest-environment jsdom
/**
 * <velxio-custom-chip> layout invariants.
 *
 * The reported overlaps had two roots: width budgeted only the single
 * longest pin label while opposing labels grow toward each other, and the
 * chip name sat at height/2 — exactly ON the middle pin row whenever a side
 * has an odd pin count. These tests pin the geometry, not pixels.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import '../velxio-elements/custom-chip-element';

function mount(chipJson: object, name = 'Custom Chip', image = ''): HTMLElement {
  const el = document.createElement('velxio-custom-chip') as HTMLElement & {
    chipJson: string; chipName: string; image: string; pinInfo: Array<{ name: string; x: number; y: number }>;
  };
  el.chipName = name;
  el.chipJson = JSON.stringify(chipJson);
  if (image) el.image = image;
  document.body.appendChild(el);
  return el;
}

/** Horizontal span a rendered pin label occupies, from its x/anchor. */
function labelSpan(t: SVGTextElement): [number, number] {
  const x = Number(t.getAttribute('x'));
  const w = (t.textContent ?? '').length * 4.8;   // 8px monospace advance
  return t.getAttribute('text-anchor') === 'start' ? [x, x + w] : [x - w, x];
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('velxio-custom-chip layout', () => {
  it('opposing long labels never meet in the middle', () => {
    const el = mount({ pins: ['TEMPERATURE_IN', 'HUMIDITY_IN', 'GND', 'MEASUREMENT_OUT', 'ALARM_OUT', 'VCC'] });
    const texts = [...el.querySelectorAll('g > text')] as SVGTextElement[];
    const starts = texts.filter(t => t.getAttribute('text-anchor') === 'start').map(labelSpan);
    const ends = texts.filter(t => t.getAttribute('text-anchor') === 'end').map(labelSpan);
    const leftEdge = Math.max(...starts.map(([, b]) => b));
    const rightEdge = Math.min(...ends.map(([a]) => a));
    expect(rightEdge - leftEdge).toBeGreaterThanOrEqual(4);
  });

  it('the name sits between pin rows, never on one', () => {
    // 5 left pins: height/2 lands exactly on the middle row without the snap.
    const el = mount({ pins: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] }, 'Sensor');
    const name = [...el.querySelectorAll('svg > text')].find(t => t.textContent === 'Sensor')!;
    const y = Number(name.getAttribute('y'));
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(y - (14 + i * 20))).toBeGreaterThanOrEqual(9);
    }
  });

  it('a long chip name is ellipsised, with the full name in the title', () => {
    const el = mount({ pins: ['IN', 'OUT'] }, 'An Extremely Verbose Chip Name Indeed');
    const name = [...el.querySelectorAll('svg > text')].pop()!;
    expect(name.textContent!.endsWith('…')).toBe(true);
    expect(el.querySelector('svg > title')!.textContent).toBe('An Extremely Verbose Chip Name Indeed');
  });

  it('an over-long pin label is ellipsised and keeps its full name on hover', () => {
    const el = mount({ pins: ['THE_UNREASONABLY_LONG_PIN_NAME', 'OUT'] });
    const g = [...el.querySelectorAll('g')].find(g => g.querySelector('title'))!;
    expect(g.querySelector('title')!.textContent).toBe('THE_UNREASONABLY_LONG_PIN_NAME');
    expect(g.querySelector('text')!.textContent!.endsWith('…')).toBe(true);
  });

  it('a face image covers the body without moving a single pin', () => {
    const json = { pins: ['VCC', 'GND', 'OUT'] };
    const bare = mount(json, 'CO2 Sensor') as ReturnType<typeof mount> & { pinInfo: never[] };
    const pinsBefore = JSON.stringify((bare as never as { pinInfo: object }).pinInfo);

    const el = mount(json, 'CO2 Sensor', 'data:image/png;base64,iVBORw0KGgo=') as never as {
      querySelectorAll: Element['querySelectorAll']; querySelector: Element['querySelector']; pinInfo: object;
    };
    const img = el.querySelector('image')!;
    expect(img).toBeTruthy();
    expect(JSON.stringify(el.pinInfo)).toBe(pinsBefore);
    // The name yields the face to the artwork but survives as the title.
    const nameText = [...el.querySelectorAll('svg > text')].find(t => t.textContent?.includes('CO2'));
    expect(nameText).toBeUndefined();
    expect(el.querySelector('svg > title')!.textContent).toBe('CO2 Sensor');
  });

  it('clearing the image restores the printed name', () => {
    const el = mount({ pins: ['IN', 'OUT'] }, 'Probe', 'data:image/png;base64,iVBORw0KGgo=') as never as {
      image: string; querySelectorAll: Element['querySelectorAll'];
    };
    el.image = '';
    const name = [...el.querySelectorAll('svg > text')].find(t => t.textContent === 'Probe');
    expect(name).toBeTruthy();
  });
});
