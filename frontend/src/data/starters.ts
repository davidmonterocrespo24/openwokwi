/**
 * Starter examples — the "New <board> project" entry points.
 *
 * Each maps a board to the gallery example that opens the editor with that
 * board and a minimal working sketch (a blink), so /example/<id> is a
 * one-click "new project" for the board, the way Wokwi's "New ESP32
 * Project" pages work. Used by:
 *   - pages/ExampleEditorPage.tsx: action-shaped <title>/description for
 *     these ids ("New ESP32 project — ...") so they can surface as brand
 *     sitelinks with usage intent (the gallery keeps the example's own title)
 *   - scripts/prerender-seo.mjs: writes dist/starters.json for the prod
 *     app shell, which serves the same head in the raw HTML
 *   - the velxio.dev landing (pro overlay): the "Start a new project" tiles
 *
 * Free boards only — a starter that lands on a paywall is not a starter.
 */
export interface StarterExample {
  /** Gallery example id (=> /example/<id>). */
  id: string;
  /** Board name as shown in the tile and the title. */
  board: string;
}

export const STARTER_EXAMPLES: readonly StarterExample[] = [
  { id: 'blink-led', board: 'Arduino Uno' },
  { id: 'nano-blink', board: 'Arduino Nano' },
  { id: 'mega-blink', board: 'Arduino Mega' },
  { id: 'esp32-blink-led', board: 'ESP32' },
  { id: 'esp32s3-blink-led', board: 'ESP32-S3' },
  { id: 'c3-blink', board: 'ESP32-C3' },
  { id: 'pico-blink', board: 'Raspberry Pi Pico' },
  { id: 'attiny85-blink', board: 'ATtiny85' },
];

/** Board name when `id` is a starter example, else undefined. */
export function starterBoard(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return STARTER_EXAMPLES.find((s) => s.id === id)?.board;
}

/** <title> for a starter's editor page. */
export function starterTitle(board: string): string {
  return `New ${board} project — free online ${board} simulator | Velxio`;
}

/** Meta description for a starter's editor page. */
export function starterDescription(board: string): string {
  return (
    `Start a new ${board} project in your browser: the editor opens with a ${board} ` +
    `and a working blink sketch — edit the code, wire components and run the ` +
    `simulation. Free, no install, no account needed.`
  );
}
