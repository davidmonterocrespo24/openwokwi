/**
 * Product-news source registry ("What's New" modal).
 *
 * Same seam pattern as proSession.ts: OSS ships a default source and the
 * pro overlay may replace it.
 *
 *   - OSS default: fetch the local backend's /api/news/feed (a cached,
 *     opt-out-able proxy of velxio.dev's public feed — see
 *     backend/app/api/routes/news.py) and run the delivery queue in the
 *     browser, with seen-state in localStorage. An anonymous install has
 *     no accounts, so "once per user" means "once per browser" here.
 *   - Pro overlay: registers a server-backed source (GET /api/pro/news/next)
 *     where the queue and per-user seen tracking live in the database.
 *
 * Queue semantics (identical in both sources):
 *   - only posts with publish_date <= today and not expired;
 *   - at most one post per calendar day;
 *   - oldest publish_date first;
 *   - a post is marked seen when SERVED, never repeated.
 */

import { getApiBase } from './apiBase';

export interface NewsPost {
  id: string;
  title: string;
  body_md: string;
  publish_date: string; // YYYY-MM-DD
  expires_date?: string | null;
}

type NewsSource = () => Promise<NewsPost | null>;

let _source: NewsSource | null = null;

export function registerNewsSource(source: NewsSource): void {
  _source = source;
}

const SEEN_KEY = 'velxio_news_seen';
const LAST_SHOWN_KEY = 'velxio_news_last_shown';

function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function readSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

async function ossFeedNext(): Promise<NewsPost | null> {
  const today = localToday();
  // Max one post per day — bail before even fetching.
  if (localStorage.getItem(LAST_SHOWN_KEY) === today) return null;

  const resp = await fetch(`${getApiBase()}/news/feed`);
  if (!resp.ok) return null;
  const posts: NewsPost[] = await resp.json();
  if (!Array.isArray(posts)) return null;

  const seen = readSeen();
  const pending = posts
    .filter(
      (p) =>
        p && typeof p.id === 'string' && !seen.has(p.id) &&
        p.publish_date <= today &&
        (!p.expires_date || p.expires_date >= today),
    )
    .sort((a, b) => a.publish_date.localeCompare(b.publish_date));
  const post = pending[0];
  if (!post) return null;

  // Mark seen at delivery time so a refresh can't show it twice.
  seen.add(post.id);
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  localStorage.setItem(LAST_SHOWN_KEY, today);
  return post;
}

/**
 * Resolve the next news post to show, or null. Never throws — news is
 * strictly best-effort and must not disturb the editor.
 */
export async function getNextNews(): Promise<NewsPost | null> {
  try {
    return _source ? await _source() : await ossFeedNext();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.debug('[oss] news source failed:', err);
    return null;
  }
}
