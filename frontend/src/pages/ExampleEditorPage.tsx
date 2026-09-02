/**
 * ExampleEditorPage — route `/example/:exampleId`.
 *
 * Paralelo a ProjectByIdPage (`/project/<uuid>`) but for the built-in
 * example projects. Loads the example into the editor + simulator
 * stores AND keeps the URL pinned to `/example/<id>` while the user
 * runs / edits. That makes example links:
 *
 *   - Shareable: copy the URL, send it, recipient lands on the same
 *     example pre-loaded.
 *   - Bookmarkable: a tab title and back-button history that point
 *     at the example, not at a generic `/editor`.
 *   - SEO-friendly: each example gets its own URL the same way
 *     /examples/<id> already gave it a landing page. The two co-
 *     exist on purpose — `/examples/<id>` (plural) is the marketing
 *     landing with preview + description, `/example/<id>` (singular)
 *     is the live editor with the example pre-loaded.
 *
 * If the user starts editing and clicks "Save", the pro overlay's
 * save modal asks for a name and creates a NEW project (no project
 * id is set on useProjectStore, so it can't overwrite anything).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useParams } from 'react-router-dom';
import { exampleProjects, subscribeProExamples,
  areProExamplesSettled, getProExamplesVersion } from '../data/examples';
import { loadExample, type LibraryInstallProgress } from '../utils/loadExample';
import { EditorPage } from './EditorPage';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { starterBoard, starterTitle, starterDescription } from '../data/starters';

const DOMAIN = 'https://velxio.dev';

export const ExampleEditorPage: React.FC = () => {
  // Re-render when the pro overlay registers late examples (dynamic import).
  useSyncExternalStore(subscribeProExamples, getProExamplesVersion, getProExamplesVersion);

  const { exampleId } = useParams<{ exampleId: string }>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [installing, setInstalling] = useState<LibraryInstallProgress | null>(null);
  // Guard so React strict-mode (which fires effects twice in dev) doesn't
  // run loadExample twice — and so the user can keep editing without the
  // example reloading on every store-triggered re-render.
  const loadedIdRef = useRef<string | null>(null);

  const example = exampleId
    ? exampleProjects.find((e) => e.id === exampleId)
    : null;

  // Starter examples are the "New <board> project" entry points: their
  // head says the action, not the sketch (the gallery keeps the sketch title).
  const board = starterBoard(example?.id);
  useSEO({
    title: board
      ? starterTitle(board)
      : example
        ? `${example.title} — Velxio Arduino Simulator`
        : 'Example — Velxio',
    description: board
      ? starterDescription(board)
      : (example?.description ?? 'Arduino example running on Velxio.'),
    url: example
      ? `${DOMAIN}/example/${example.id}`
      : `${DOMAIN}/examples`,
  });

  const settled = useSyncExternalStore(
    subscribeProExamples,
    areProExamplesSettled,
    areProExamplesSettled,
  );

  useEffect(() => {
    // `settled` is deliberately NOT a dependency. A direct link to a pro
    // example can begin loading the moment the overlay registers it — one
    // microtask BEFORE the overlay's import promise settles. With `settled`
    // in the deps, that flip re-fired the effect mid-load: the cleanup set
    // `cancelled`, setReady was skipped, and the re-run hit the loadedIdRef
    // guard and returned — the page hung on "Loading example…" forever
    // (found with the reSpeaker example; any /example/<pro-id> direct URL
    // could lose this race). The 404 decision lives in the render below,
    // where reading `settled` doesn't cancel anything.
    if (!exampleId || !example) return;
    if (loadedIdRef.current === exampleId) return;
    loadedIdRef.current = exampleId;

    let cancelled = false;
    let done = false;
    setReady(false);
    setError(false);
    (async () => {
      try {
        await loadExample(example, setInstalling);
      } catch {
        // loadExample's internal failures (library install network errors)
        // are swallowed inside ensureLibraries — anything that DOES bubble
        // up here means the stores are partially populated. Surfacing a
        // clean error is more useful than rendering an empty editor.
        done = true;
        if (!cancelled) setError(true);
        return;
      }
      done = true;
      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
      // A load cancelled mid-flight must not poison the guard: if this
      // effect re-runs for the same id, it has to actually reload instead
      // of early-returning with `ready` still false.
      if (!done && loadedIdRef.current === exampleId) {
        loadedIdRef.current = null;
      }
    };
  }, [exampleId, example]);

  // "Not in the gallery" and "not in the gallery YET" are different answers
  // while the pro overlay's dynamic import is still in flight: only once the
  // registry settles is a missing id really a 404.
  if (error || !exampleId || (settled && !example)) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          background: 'var(--wb-2)',
        }}
      >
        <AppHeader />
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
          }}
        >
          <div style={{ fontSize: 48, color: 'var(--wb-8)' }}>404</div>
          <div style={{ fontSize: 16, color: 'var(--wb-11)' }}>
            Example &quot;{exampleId}&quot; not found.
          </div>
          <a
            href="/examples"
            style={{
              color: '#4fc3f7',
              textDecoration: 'none',
              border: '1px solid #4fc3f7',
              borderRadius: 4,
              padding: '8px 20px',
              fontSize: 14,
            }}
          >
            Browse all examples
          </a>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--wb-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ textAlign: 'center', color: 'var(--wb-12)' }}>
          <div style={{ fontSize: 15 }}>Loading example…</div>
          {installing && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--wb-11)' }}>
              Installing {installing.current} ({installing.done + 1}/{installing.total})
            </div>
          )}
        </div>
      </div>
    );
  }

  return <EditorPage />;
};
