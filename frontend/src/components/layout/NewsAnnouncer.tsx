/**
 * Product news ("What's New") — an announcement modal on editor entry.
 *
 * This started life as an auto-opened modal, was demoted to a corner
 * toast (it used to stack on top of the starter-template dialog), and is
 * now a modal again — the toast simply went unread. What makes the modal
 * viable this time is sequencing, not stacking: EditorPage holds the
 * pristine-visit "Start a new project" dialog until this component
 * reports through lib/newsGate.ts that news is out of the way (nothing
 * to show, or the modal was closed). One startup overlay on screen at a
 * time, announcement first — and the announcement renders slightly wider
 * than the starter dialog so it reads as the headline, not a leftover.
 *
 * The queue/seen logic lives in lib/newsSource.ts (OSS: localStorage
 * over /api/news/feed; pro: server-backed per user). The fetch starts
 * almost immediately — the starter dialog is waiting on the decision —
 * and every failure path resolves to "nothing shown", which opens the
 * gate. The last delivered post stays reachable from Help ▸ What's new.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getNextNews, type NewsPost } from '../../lib/newsSource';
import { reportNewsEvent } from '../../lib/newsEvents';
import { markNewsShowing, markNewsNone, markNewsClosed } from '../../lib/newsGate';
import { NewsMarkdown } from './NewsMarkdown';
import { registerEditorCommand } from '../../lib/editorCommands';
import './NewsAnnouncer.css';

/** One tick of breathing room so the fetch never competes with the very
 *  first render burst; kept tiny because the starter dialog waits on us. */
const FETCH_DELAY_MS = 250;

export function NewsAnnouncer() {
  const { t } = useTranslation();
  const [post, setPost] = useState<NewsPost | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void getNextNews().then((p) => {
        if (cancelled) return;
        if (!p) {
          markNewsNone();
          return;
        }
        setPost(p);
        setExpanded(true);
        markNewsShowing();
        reportNewsEvent('impression', p.id);
      });
    }, FETCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // No gate call in cleanup: a cancelled fetch leaves the gate
    // 'pending', and whenNewsClear's pending timeout covers that path.
  }, []);

  // Help ▸ What's new re-opens the last delivered post. Registered even
  // with nothing to show yet; the handler no-ops until a post arrives,
  // which keeps the menu row's enabled state honest once one has.
  useEffect(() => {
    if (!post) return;
    return registerEditorCommand('help.whatsNew', () => {
      setExpanded(true);
      reportNewsEvent('open', post.id, { via: 'menu' });
    });
  }, [post]);

  if (!post || !expanded) return null;

  const close = () => {
    setExpanded(false);
    markNewsClosed();
  };

  return createPortal(
    <div className="velxio-news-overlay" onClick={close}>
      <div
        className="velxio-news-modal"
        role="dialog"
        aria-modal="true"
        aria-label={post.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="velxio-news-header">
          <div>
            <span className="velxio-news-kicker">
              {t('news.kicker', "What's new")}
            </span>
            <h2 className="velxio-news-title">{post.title}</h2>
          </div>
          <button
            className="velxio-news-close"
            aria-label={t('news.close', 'Close')}
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className="velxio-news-body">
          <NewsMarkdown
            onInteract={(kind, href) =>
              reportNewsEvent(
                kind === 'video' ? 'video_play' : 'link_click',
                post.id,
                { href },
              )
            }
          >
            {post.body_md}
          </NewsMarkdown>
        </div>
        <div className="velxio-news-footer">
          <button className="velxio-news-ok" onClick={close}>
            {t('news.gotIt', 'Got it')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
