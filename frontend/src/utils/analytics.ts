/**
 * Google Analytics 4 Key Events Tracking
 *
 * Provides helper functions to fire GA4 custom events for key user actions.
 * Each function maps to an event that should be marked as a Key Event in GA4.
 */

type GtagFn = (command: 'event', eventName: string, eventParams?: Record<string, unknown>) => void;

function fireEvent(eventName: string, params: Record<string, string | number | boolean>): void {
  const gtag = (window as unknown as { gtag?: GtagFn }).gtag;
  if (typeof gtag === 'function') {
    gtag('event', eventName, params);
  }
}

// ── Simulation ──────────────────────────────────────────────────────────────

/** Fired when the user starts a simulation (clicks Run). */
export function trackRunSimulation(board?: string): void {
  fireEvent('run_simulation', {
    event_category: 'engagement',
    ...(board ? { board } : {}),
  });
}

/** Fired when the user stops a running simulation. */
export function trackStopSimulation(): void {
  fireEvent('stop_simulation', { event_category: 'engagement' });
}

/** Fired when the user resets a simulation. */
export function trackResetSimulation(): void {
  fireEvent('reset_simulation', { event_category: 'engagement' });
}

// ── Editor / Canvas ─────────────────────────────────────────────────────────

/** Fired when code compilation starts. */
export function trackCompileCode(): void {
  fireEvent('compile_code', { event_category: 'development' });
}

/** Fired when the user changes the board type. */
export function trackSelectBoard(board: string): void {
  fireEvent('select_board', { event_category: 'engagement', board });
}

/** Fired when the user adds a component to the canvas. */
export function trackAddComponent(componentType: string): void {
  fireEvent('add_component', { event_category: 'engagement', component_type: componentType });
}

/** Fired when the user finishes creating a wire between two pins. */
export function trackCreateWire(): void {
  fireEvent('create_wire', { event_category: 'engagement' });
}

/** Fired when the user opens or closes the Serial Monitor. */
export function trackToggleSerialMonitor(open: boolean): void {
  fireEvent('toggle_serial_monitor', {
    event_category: 'engagement',
    state: open ? 'open' : 'close',
  });
}

// ── Examples ────────────────────────────────────────────────────────────────

/** Fired when a user loads a sample project from the examples gallery. */
export function trackOpenExample(exampleTitle?: string): void {
  fireEvent('open_example', {
    event_category: 'engagement',
    ...(exampleTitle ? { event_label: exampleTitle } : {}),
  });
}

// ── Projects ────────────────────────────────────────────────────────────────

/** Fired when a user successfully creates a new project. */
export function trackCreateProject(): void {
  fireEvent('create_project', { event_category: 'engagement' });
}

/** Fired when a user saves/updates an existing project. */
export function trackSaveProject(): void {
  fireEvent('save_project', { event_category: 'engagement' });
}

// ── Auth ────────────────────────────────────────────────────────────────────

/** Fired on successful sign-up. */
export function trackSignUp(method: 'email' | 'google'): void {
  fireEvent('sign_up', { event_category: 'auth', method });
}

/** Fired on successful login. */
export function trackLogin(method: 'email' | 'google'): void {
  fireEvent('login', { event_category: 'auth', method });
}

// ── External Links ──────────────────────────────────────────────────────────

/** Fired when a user clicks any GitHub repository link. */
export function trackVisitGitHub(): void {
  fireEvent('visit_github', { event_category: 'external_link' });
}

/** Fired when a user clicks any Discord invite link. */
export function trackVisitDiscord(): void {
  fireEvent('visit_discord', { event_category: 'external_link' });
}

/**
 * Fired when a user clicks a datasheet "Product page" link. Besides the GA4
 * event, dispatches a DOM CustomEvent so an overlay build can persist the
 * click server-side (partner attribution) without this tree knowing about it.
 */
export function trackProductPageClick(componentId: string, brand?: string, href?: string): void {
  fireEvent('product_page_click', {
    event_category: 'external_link',
    component_type: componentId,
    brand: brand ?? '(none)',
  });
  window.dispatchEvent(
    new CustomEvent('velxio:product-page-click', {
      detail: { componentId, brand: brand ?? null, href: href ?? null },
    }),
  );
}

// ── CTA / Conversion ────────────────────────────────────────────────────────

/**
 * Fired when a user clicks a CTA button on a landing/SEO page.
 *
 * The originating page is sent as `cta_source`, NOT `source`: `source`
 * (like `medium` and `campaign`) is a reserved traffic-source parameter in
 * GA4, so every CTA click was rewriting the session's acquisition source to
 * "landing" / "arduino-simulator" / "rpi-simulator" with medium "(not set)"
 * — 16% of sessions landed in the Unassigned channel with no real origin.
 */
export function trackClickCTA(source: string, destination: string): void {
  fireEvent('click_cta', { event_category: 'conversion', cta_source: source, destination });
}

// ── Library Manager ─────────────────────────────────────────────────────────

/** Fired when a user opens the Library Manager panel. */
export function trackOpenLibraryManager(): void {
  fireEvent('open_library_manager', { event_category: 'engagement' });
}

/** Fired when a user installs a library. */
export function trackInstallLibrary(libraryName: string): void {
  fireEvent('install_library', { event_category: 'development', library_name: libraryName });
}
