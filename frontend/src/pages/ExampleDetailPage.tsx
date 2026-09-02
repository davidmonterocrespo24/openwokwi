/**
 * ExampleDetailPage — SEO landing page for a single example.
 *
 * Route: /examples/:exampleId
 *
 * Shows example title, description, category, difficulty and board type with
 * a CTA to open the example in the simulator.  Fully prerenderable at build
 * time (no browser-only APIs on first render) so every example gets its own
 * statically-served HTML for search engines.
 */

import React from 'react';
import { useSyncExternalStore } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { exampleProjects, subscribeProExamples, getProExamplesVersion } from '../data/examples';
import { AppHeader } from '../components/layout/AppHeader';
import { ExampleThumbnail } from '../components/examples/ExampleThumbnail';
import { useSEO } from '../utils/useSEO';

const DOMAIN = 'https://velxio.dev';

const BOARD_LABELS: Record<string, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega',
  'raspberry-pi-pico': 'Raspberry Pi Pico (RP2040)',
  esp32: 'ESP32',
  'esp32-s3': 'ESP32-S3',
  'esp32-c3': 'ESP32-C3',
};

const CATEGORY_LABELS: Record<string, string> = {
  basics: 'Basics',
  sensors: 'Sensors',
  displays: 'Displays',
  communication: 'Communication',
  games: 'Games',
  robotics: 'Robotics',
};

const DIFFICULTY_COLOR: Record<string, string> = {
  beginner: '#4caf50',
  intermediate: '#ff9800',
  advanced: '#f44336',
};

export const ExampleDetailPage: React.FC = () => {
  // Re-render when the pro overlay registers late examples (dynamic import).
  useSyncExternalStore(subscribeProExamples, getProExamplesVersion, getProExamplesVersion);

  const { exampleId } = useParams<{ exampleId: string }>();
  const navigate = useNavigate();

  const example = exampleId ? exampleProjects.find((e) => e.id === exampleId) : null;

  // SEO — called unconditionally (hooks must not be inside conditionals).
  const seoTitle = example
    ? `${example.title} — Free Arduino Simulator Example | Velxio`
    : 'Example Not Found | Velxio';

  const boardLabel = example
    ? (BOARD_LABELS[example.boardType ?? 'arduino-uno'] ?? example.boardType ?? 'Arduino Uno')
    : '';

  const seoDescription = example
    ? `${example.description}. Run this ${boardLabel} example free in your browser — no install, no account required.`
    : 'This example was not found.';

  useSEO({
    title: seoTitle,
    description: seoDescription,
    url: `${DOMAIN}/examples/${exampleId ?? ''}`,
  });

  const handleOpen = () => {
    if (!example) return;
    // Navigate to the live editor URL — ExampleEditorPage owns the load.
    // Pinning the URL means the user can refresh / share the link and
    // keep the example loaded.
    navigate(`/example/${example.id}`);
  };

  // ── 404 state ───────────────────────────────────────────────────────────────
  if (!example) {
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
          <div style={{ fontSize: 16, color: 'var(--wb-11)' }}>Example "{exampleId}" not found.</div>
          <Link
            to="/examples"
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
          </Link>
        </div>
      </div>
    );
  }

  const diffColor = DIFFICULTY_COLOR[example.difficulty] ?? 'var(--wb-11)';
  const categoryLabel = CATEGORY_LABELS[example.category] ?? example.category;

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

      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '48px 24px 80px',
        }}
      >
        {/* Breadcrumb */}
        <nav
          style={{ width: '100%', maxWidth: 760, marginBottom: 32, fontSize: 13, color: 'var(--wb-9)' }}
        >
          <Link to="/" style={{ color: 'var(--wb-9)', textDecoration: 'none' }}>
            Velxio
          </Link>
          {' / '}
          <Link to="/examples" style={{ color: 'var(--wb-9)', textDecoration: 'none' }}>
            Examples
          </Link>
          {' / '}
          <span style={{ color: 'var(--wb-11)' }}>{example.title}</span>
        </nav>

        {/* Card */}
        <article
          style={{
            width: '100%',
            maxWidth: 760,
            background: 'var(--wb-3)',
            border: '1px solid var(--wb-6)',
            borderRadius: 12,
            padding: '40px 48px',
          }}
        >
          {/* Circuit preview */}
          <div
            style={{
              width: '100%',
              borderRadius: 8,
              overflow: 'hidden',
              marginBottom: 28,
              border: '1px solid var(--wb-6)',
            }}
          >
            <ExampleThumbnail
              example={example}
              width={760}
              height={240}
              background="var(--wb-0)"
              style={{ width: '100%', height: 240, borderRadius: 7 }}
            />
          </div>

          {/* Badges */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: 'var(--color-accent-soft)',
                color: '#4fc3f7',
              }}
            >
              {categoryLabel}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: `${diffColor}22`,
                color: diffColor,
              }}
            >
              {example.difficulty}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: 'var(--wb-4)',
                color: 'var(--wb-11)',
              }}
            >
              {boardLabel}
            </span>
          </div>

          {/* Title */}
          <h1
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: 'var(--wb-12)',
              margin: '0 0 16px',
              lineHeight: 1.3,
            }}
          >
            {example.title}
          </h1>

          {/* Description */}
          <p style={{ fontSize: 16, color: 'var(--wb-11)', lineHeight: 1.7, margin: '0 0 32px' }}>
            {example.description}
          </p>

          {/* What you'll learn section */}
          <section style={{ marginBottom: 36 }}>
            <h2
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--wb-10)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                margin: '0 0 12px',
              }}
            >
              What you'll simulate
            </h2>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: 'var(--wb-12)',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                Real {boardLabel} emulation — cycle-accurate, no hardware needed
              </li>
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: 'var(--wb-12)',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                {(example.components?.length ?? 0) > 0
                  ? `${example.components.length} interactive component${example.components.length > 1 ? 's' : ''} on the canvas`
                  : 'Interactive simulation canvas'}
              </li>
              {example.libraries && example.libraries.length > 0 && (
                <li
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--wb-12)',
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                  Auto-installs: {example.libraries.join(', ')}
                </li>
              )}
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: 'var(--wb-12)',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                Serial Monitor included — see output in real time
              </li>
            </ul>
          </section>

          {/* CTA */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleOpen}
              style={{
                background: '#0e639c',
                border: 'none',
                borderRadius: 6,
                color: 'var(--color-fg-on-action)',
                fontSize: 15,
                fontWeight: 600,
                padding: '12px 28px',
                cursor: 'pointer',
                letterSpacing: '0.02em',
              }}
            >
              Open in Simulator
            </button>
            <Link to="/examples" style={{ color: 'var(--wb-9)', textDecoration: 'none', fontSize: 14 }}>
              ← Back to examples
            </Link>
          </div>
        </article>

        {/* JSON-LD structured data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'LearningResource',
              name: example.title,
              description: seoDescription,
              url: `${DOMAIN}/examples/${example.id}`,
              educationalLevel: example.difficulty,
              learningResourceType: 'Simulation',
              provider: { '@type': 'Organization', name: 'Velxio', url: DOMAIN },
              about: { '@type': 'Thing', name: boardLabel },
            }),
          }}
        />
      </main>

      {/* Library install overlay used to live here — moved to
          ExampleEditorPage now that loading runs at /example/<id>. */}
    </div>
  );
};
