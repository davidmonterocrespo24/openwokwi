/**
 * Markdown renderer for product-news content ("What's New" modal and the
 * admin authoring preview — keep both on this one component so what the
 * admin previews is exactly what users see).
 *
 * On top of plain GFM:
 *   - Any YouTube link (watch/shorts/youtu.be/embed) renders as a
 *     click-to-play preview: thumbnail + play badge, swapped for the
 *     youtube-nocookie iframe on click. Nothing loads from YouTube's
 *     player until the user opts in; the thumbnail is a static image.
 *   - Images (and GIFs) render inline. Deliberate product decision:
 *     news posts embed screenshots/demos, so viewers' browsers DO fetch
 *     remote media from the posts — documented in the OSS README next
 *     to the VELXIO_NEWS opt-out.
 *   - A bare image URL (autolinked by GFM, link text == href) renders
 *     as the image itself — authors paste screenshot URLs without
 *     knowing the ![](…) syntax. An explicit [label](…png) stays a link.
 *   - All links open in a new tab (the modal sits on top of the editor;
 *     navigating away would lose workspace state).
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function isImageHref(href: string): boolean {
  return (
    /^https?:\/\//i.test(href) &&
    /\.(png|jpe?g|gif|webp|avif|svg)(?=$|[?#])/i.test(href)
  );
}

function youTubeId(href: string): string | null {
  const m = href.match(
    /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/,
  );
  return m ? m[1] : null;
}

function YouTubePreview({ id }: { id: string }) {
  const [playing, setPlaying] = useState(false);
  if (playing) {
    return (
      <span className="velxio-news-video">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`}
          title="YouTube video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="velxio-news-video velxio-news-video-thumb"
      onClick={() => setPlaying(true)}
      aria-label="Play video"
    >
      <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="Video preview" loading="lazy" />
      <span className="velxio-news-play">▶</span>
    </button>
  );
}

export function NewsMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children: kids }) => {
          const text = Array.isArray(kids) ? kids.join('') : String(kids ?? '');
          const id = href ? youTubeId(href) : null;
          if (id) {
            return (
              <>
                <YouTubePreview id={id} />
                {text && text !== href && (
                  <a href={href} target="_blank" rel="noreferrer">{kids}</a>
                )}
              </>
            );
          }
          if (href && isImageHref(href) && (!text || text === href)) {
            return <img src={href} alt="" loading="lazy" />;
          }
          return (
            <a href={href} target="_blank" rel="noreferrer">{kids}</a>
          );
        },
        img: ({ src, alt }) => (
          <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} loading="lazy" />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
