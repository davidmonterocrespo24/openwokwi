/**
 * Examples Page Component
 *
 * Displays the examples gallery. Clicking a tile navigates to
 * `/example/<id>` — ExampleEditorPage owns the actual load (library
 * install, store mutations) and keeps the URL pinned for the lifetime
 * of the session so examples are shareable like saved projects are.
 */

import React from 'react';
import { useSyncExternalStore } from 'react';
import { subscribeProExamples, getProExamplesVersion } from '../data/examples';
import { useNavigate } from 'react-router-dom';
import { ExamplesGallery } from '../components/examples/ExamplesGallery';
import { CommunityProjectsGrid } from '../components/examples/CommunityProjectsGrid';
import { AppHeader } from '../components/layout/AppHeader';
import { useLocalizedHref } from '../i18n/useLocalizedNavigate';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import type { ExampleProject } from '../data/examples';

export const ExamplesPage: React.FC = () => {
  // Re-render when the pro overlay registers late examples (dynamic import).
  useSyncExternalStore(subscribeProExamples, getProExamplesVersion, getProExamplesVersion);

  const localize = useLocalizedHref();
  useSEO(getSeoMeta('/examples')!);

  const navigate = useNavigate();

  const handleLoadExample = (example: ExampleProject) => {
    navigate(localize(`/example/${example.id}`));
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: '#1e1e1e',
      }}
    >
      <AppHeader />
      <ExamplesGallery onLoadExample={handleLoadExample} />
      <CommunityProjectsGrid />
    </div>
  );
};
