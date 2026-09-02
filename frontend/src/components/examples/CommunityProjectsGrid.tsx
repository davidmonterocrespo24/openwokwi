/**
 * CommunityProjectsGrid — second section on /examples beneath the
 * hardcoded official examples.  Fetches `/api/projects/featured` (a
 * pro-overlay-only endpoint that returns the top public projects ranked
 * by run_count).
 *
 * Renders nothing when the fetch fails / returns empty so the OSS build
 * (which has no projects route at all) degrades to its old layout
 * without surfacing an error.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLocalizedHref } from '../../i18n/useLocalizedNavigate';

type FeaturedProject = {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  owner_username: string;
  board_type: string;
  run_count: number;
  compile_count: number;
};

const BOARD_LABELS: Record<string, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega',
  'esp32': 'ESP32',
  'esp32-s3': 'ESP32-S3',
  'esp32-c3': 'ESP32-C3',
  'raspberry-pi-pico': 'Pico',
  'raspberry-pi-3': 'Pi 3',
  'attiny85': 'ATtiny85',
};

export const CommunityProjectsGrid = () => {
  const [projects, setProjects] = useState<FeaturedProject[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const localize = useLocalizedHref();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/projects/featured?limit=12', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return (await r.json()) as FeaturedProject[];
      })
      .then((rows) => {
        if (cancelled) return;
        if (!rows.length) {
          setHidden(true);
          return;
        }
        setProjects(rows);
      })
      .catch(() => { if (!cancelled) setHidden(true); });
    return () => { cancelled = true; };
  }, []);

  if (hidden || !projects) return null;

  return (
    <section style={styles.shell}>
      <div style={styles.header}>
        <h2 style={styles.title}>Featured community projects</h2>
        <p style={styles.sub}>
          The most-run public circuits on Velxio. Open one to see how it's wired,
          remix the code, and run it live.
        </p>
      </div>
      <div style={styles.grid}>
        {projects.map((p) => (
          <Link
            key={p.id}
            to={localize(`/${p.owner_username}/${p.slug}`)}
            style={styles.card}
            className="velxio-community-card"
          >
            <div style={styles.cardName}>{p.name || 'Untitled'}</div>
            <div style={styles.cardMeta}>
              <span>{BOARD_LABELS[p.board_type] || p.board_type}</span>
              <span>·</span>
              <span>{p.run_count.toLocaleString()} runs</span>
            </div>
            <div style={styles.cardOwner}>by @{p.owner_username}</div>
            {p.description && (
              <div style={styles.cardDesc}>{p.description.slice(0, 140)}</div>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
};

const styles: Record<string, React.CSSProperties> = {
  shell: {
    maxWidth: 1280,
    margin: '40px auto 60px',
    padding: '0 24px',
    color: 'var(--wb-12)',
  },
  header: { marginBottom: 24 },
  title: { fontSize: 24, fontWeight: 600, color: 'var(--wb-13)', margin: 0 },
  sub: { color: 'var(--wb-11)', fontSize: 14, margin: '6px 0 0 0', maxWidth: 640 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: 14,
  },
  card: {
    display: 'block',
    background: 'var(--wb-2)',
    border: '1px solid var(--wb-4)',
    borderRadius: 8,
    padding: '14px 16px',
    textDecoration: 'none',
    color: 'inherit',
    transition: 'border-color 0.12s, transform 0.12s',
  },
  cardName: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--wb-13)',
    marginBottom: 6,
  },
  cardMeta: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    color: 'var(--wb-10)',
    fontSize: 12,
  },
  cardOwner: {
    color: '#4fc3f7',
    fontSize: 12,
    marginTop: 6,
  },
  cardDesc: {
    color: 'var(--wb-11)',
    fontSize: 13,
    marginTop: 8,
    lineHeight: 1.45,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
};
