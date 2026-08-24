/**
 * Product-news interaction sink ("What's New" telemetry seam).
 *
 * Same seam pattern as newsSource.ts / proSession.ts: OSS ships a no-op
 * default and an extension overlay may register a sink that forwards the
 * signals wherever it wants (velxio.dev sends them to its analytics
 * pipeline). A pure OSS build never reports anything anywhere — the
 * events below simply vanish.
 *
 * Event vocabulary (postId is always the news post's id):
 *   - impression  → the corner toast rendered for the user
 *   - open        → the full post modal was opened (detail.via:
 *                   'toast' | 'menu')
 *   - link_click  → a link inside the post body was clicked
 *                   (detail.href)
 *   - video_play  → a YouTube preview inside the body was started
 *                   (detail.href)
 */

export type NewsEventKind = 'impression' | 'open' | 'link_click' | 'video_play';

export interface NewsEventDetail {
  /** Target URL for link_click / video_play. */
  href?: string;
  /** How the modal was opened for 'open'. */
  via?: 'toast' | 'menu';
}

type NewsEventSink = (
  kind: NewsEventKind,
  postId: string,
  detail?: NewsEventDetail,
) => void;

let _sink: NewsEventSink | null = null;

export function registerNewsEventSink(sink: NewsEventSink): void {
  _sink = sink;
}

/**
 * Report a news interaction. Never throws — telemetry must not be able
 * to break the announcement UI.
 */
export function reportNewsEvent(
  kind: NewsEventKind,
  postId: string,
  detail?: NewsEventDetail,
): void {
  try {
    _sink?.(kind, postId, detail);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.debug('[oss] news event sink failed:', err);
  }
}
