/**
 * Pro-route registry.
 *
 * App.tsx defines the OSS route table at module load. Routes that only
 * make sense in a private deployment (login, register, admin, user
 * profile, project-by-slug, etc.) are registered separately by the pro
 * overlay's mountPro() and merged into the route tree via this module.
 *
 * Subscription is `useSyncExternalStore`-based so any registration that
 * happens AFTER the initial App render still produces a synchronous
 * re-render — the user never sees a "Not Found" flash for routes the
 * overlay was about to add. In practice the dynamic import of
 * `@pro/index` resolves before the user can navigate, but the contract
 * guarantees correctness even if it didn't.
 *
 * Calling registerProRoutes() more than once REPLACES the previous set
 * (idempotent — pro can re-register on hot reload without leaking
 * duplicate entries). Pass [] to clear.
 */

import { useSyncExternalStore, type ReactElement } from 'react';

export interface ProRoute {
  /** Route path WITHOUT leading slash, matching App.tsx's ROUTES convention. */
  path: string;
  element: ReactElement;
  /** True if this is the locale root (path === '' for /<locale>/). */
  index?: boolean;
}

let _routes: ProRoute[] = [];
const _listeners = new Set<() => void>();

export function registerProRoutes(routes: ProRoute[]): void {
  _routes = routes;
  for (const listener of _listeners) listener();
}

function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

function getSnapshot(): ProRoute[] {
  return _routes;
}

export function useProRoutes(): ProRoute[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Has the overlay had its chance to register routes?
 *
 * The OSS root ('/') redirects to /editor — but only once it KNOWS no
 * overlay is going to claim the home page. Redirecting on first render
 * would race the overlay's dynamic import and bounce velxio.dev visitors
 * into the editor before the landing page ever registered. main.tsx flips
 * this when the overlay import settles, or immediately when no overlay is
 * configured. Same contract as markProExamplesSettled in data/examples.
 */
let _settled = false;

export function markProRoutesSettled(): void {
  if (_settled) return;
  _settled = true;
  for (const listener of _listeners) listener();
}

const getSettled = (): boolean => _settled;

export function useProRoutesSettled(): boolean {
  return useSyncExternalStore(subscribe, getSettled, getSettled);
}
