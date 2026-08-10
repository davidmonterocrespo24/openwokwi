/**
 * "What's New" modal — shows the next pending product-news post when the
 * user enters the editor. At most one per day, each post only ever once;
 * the queue/seen logic lives in lib/newsSource.ts (OSS: localStorage over
 * the local /api/news/feed proxy; pro overlay: server-backed per-user).
 *
 * The fetch is delayed a few seconds so it never competes with editor
 * startup, and every failure path resolves to "no modal".
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getNextNews, type NewsPost } from '../../lib/newsSource';
import { NewsMarkdown } from './NewsMarkdown';
import './NewsModal.css';

const FETCH_DELAY_MS = 4000;

export function NewsModal() {
  const [post, setPost] = useState<NewsPost | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void getNextNews().then((p) => {
        if (!cancelled && p) setPost(p);
      });
    }, FETCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!post) return null;

  return createPortal(
    <div className="velxio-news-overlay" onClick={() => setPost(null)}>
      <div
        className="velxio-news-modal"
        role="dialog"
        aria-modal="true"
        aria-label={post.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="velxio-news-header">
          <div>
            <span className="velxio-news-kicker">What's new</span>
            <h2 className="velxio-news-title">{post.title}</h2>
          </div>
          <button
            className="velxio-news-close"
            aria-label="Close"
            onClick={() => setPost(null)}
          >
            ×
          </button>
        </div>
        <div className="velxio-news-body">
          <NewsMarkdown>{post.body_md}</NewsMarkdown>
        </div>
        <div className="velxio-news-footer">
          <button className="velxio-news-ok" onClick={() => setPost(null)}>
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
