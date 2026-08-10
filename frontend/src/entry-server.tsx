/**
 * SSR entry point for prerendering SEO pages at build time.
 *
 * Used by scripts/prerender-seo.mjs via Vite's ssrLoadModule.
 * Renders each page component to an HTML string so the prerender script
 * can inject it into the static dist/index.html per route.
 */

import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SEO_ROUTES } from './seoRoutes';

// ── SEO page components ─────────────────────────────────────────────────────
import { exampleProjects } from './data/examples';
import { ExamplesPage } from './pages/ExamplesPage';
import { ExampleDetailPage } from './pages/ExampleDetailPage';

// Map route paths to their React component. The OSS build prerenders only
// what it ships (the examples gallery); the marketing surface lives in the
// pro overlay and is merged in by loadRouteComponents() below.
const OSS_ROUTE_COMPONENTS: Record<string, React.FC> = {
  '/examples': ExamplesPage,
};

let routeComponents: Record<string, React.FC> = OSS_ROUTE_COMPONENTS;

/**
 * Merge in the overlay's marketing pages (landing, about, docs, the SEO
 * simulator landings). Pro-gated dynamic import — the never-taken branch
 * keeps the OSS build from ever referencing files it does not have, the
 * same pattern main.tsx uses for mountPro. The prerender script awaits
 * this before asking for routes.
 */
export async function loadRouteComponents(): Promise<Record<string, React.FC>> {
  if (import.meta.env.VITE_PRO_BUILD) {
    const m = await import('@pro/pages/marketing');
    routeComponents = { ...OSS_ROUTE_COMPONENTS, ...m.MARKETING_ROUTE_COMPONENTS };
  }
  return routeComponents;
}

/**
 * Returns all routes that have both seoMeta and a renderable component.
 */
export function getPrerenderedRoutes() {
  return SEO_ROUTES.filter((r) => r.seoMeta && routeComponents[r.path]);
}

/**
 * Render a route's page component to an HTML string.
 */
export function render(path: string): string {
  const Component = routeComponents[path];
  if (!Component) return '';

  try {
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <Component />
      </MemoryRouter>,
    );
  } catch (err) {
    console.warn(`  ⚠ SSR render failed for ${path}:`, (err as Error).message);
    return '';
  }
}

/**
 * Returns all example routes to prerender, one per example project.
 */
export function getPrerenderedExampleRoutes() {
  return exampleProjects.map((e) => ({
    path: `/examples/${e.id}`,
    title: `${e.title} — Free Arduino Simulator Example | Velxio`,
    description: `${e.description}. Run this example free in your browser — no install, no account required.`,
    url: `https://velxio.dev/examples/${e.id}`,
  }));
}

/**
 * Render an example detail page to an HTML string.
 */
export function renderExample(exampleId: string): string {
  try {
    return renderToString(
      <MemoryRouter initialEntries={[`/examples/${exampleId}`]}>
        <ExampleDetailPage />
      </MemoryRouter>,
    );
  } catch (err) {
    console.warn(`  ⚠ SSR render failed for /examples/${exampleId}:`, (err as Error).message);
    return '';
  }
}
