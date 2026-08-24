import { useEffect, useRef } from 'react';
import { LOCALES, LOCALE_META, DEFAULT_LOCALE } from '../i18n/config';
import { getLocaleFromPath, stripLocaleFromPath, localizedPath } from '../i18n/path';
import { SEO_ROUTES } from '../seoRoutes';

export interface SEOMeta {
  title: string;
  description: string;
  url: string;
  ogImage?: string;
  /** Module-level constant: injected once on mount, removed on unmount. */
  jsonLd?: object | object[];
  /** If true, sets robots meta to "noindex, nofollow" to prevent indexing. */
  noindex?: boolean;
}

function qs(selector: string): HTMLMetaElement | null {
  return document.querySelector(selector) as HTMLMetaElement | null;
}

/**
 * Canonical + og:url must carry a trailing slash to match the URL the server
 * actually serves (nginx 301-redirects the slash-less form), so the canonical
 * never points at a redirecting URL and project pages agree with their
 * sitemap entry. Query/hash are preserved.
 */
function withTrailingSlash(u: string): string {
  try {
    const parsed = new URL(u, 'https://velxio.dev');
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed.toString();
  } catch {
    return u.endsWith('/') ? u : `${u}/`;
  }
}

const DOMAIN = 'https://velxio.dev';
const HREFLANG_ATTR = 'data-seo-hreflang';

/**
 * Pages that exist once per locale (`/es/esp32-simulator/` renders the same
 * marketing page in Spanish): the static SEO routes plus the home. Everything
 * else — user projects, profiles, gallery example pages — is the same
 * English content under every prefix, so it keeps a single locale-less
 * canonical and no hreflang.
 */
const LOCALIZED_ROUTE_PATHS = new Set(
  SEO_ROUTES.filter((r) => !r.noindex).map((r) => (r.path === '/' ? '/' : r.path.replace(/\/$/, ''))),
);

function isLocalizedRoute(strippedPath: string): boolean {
  const key = strippedPath === '/' ? '/' : strippedPath.replace(/\/$/, '');
  return LOCALIZED_ROUTE_PATHS.has(key);
}

/**
 * Canonical + hreflang for the current URL. For a localized route the
 * canonical is the page's OWN locale variant (`/es/esp32-simulator/`), and
 * every locale variant is listed as an alternate with `x-default` on the
 * locale-less English URL. Declaring canonical=/ from /es/ told Google the
 * Spanish page was a duplicate while it was ranking on its own; this
 * matches what Google already does with the pages.
 */
function localeLinks(url: string): { canonical: string; alternates: { hreflang: string; href: string }[] } {
  const canonicalDefault = withTrailingSlash(url);
  let strippedPath: string;
  try {
    strippedPath = stripLocaleFromPath(new URL(url, DOMAIN).pathname);
  } catch {
    return { canonical: canonicalDefault, alternates: [] };
  }
  if (!isLocalizedRoute(strippedPath)) return { canonical: canonicalDefault, alternates: [] };
  // A page whose canonical is another page (/v2 -> /) keeps that canonical
  // as given and declares no alternates.
  if (typeof window !== 'undefined') {
    const herePath = stripLocaleFromPath(window.location.pathname).replace(/\/+$/, '') || '/';
    const urlPath = strippedPath.replace(/\/+$/, '') || '/';
    if (herePath !== urlPath) return { canonical: canonicalDefault, alternates: [] };
  }
  const current = typeof window !== 'undefined' ? getLocaleFromPath(window.location.pathname) : DEFAULT_LOCALE;
  const variant = (l: (typeof LOCALES)[number]) => withTrailingSlash(`${DOMAIN}${localizedPath(strippedPath, l)}`);
  return {
    canonical: variant(current),
    alternates: [
      ...LOCALES.map((l) => ({ hreflang: LOCALE_META[l].htmlLang, href: variant(l) })),
      { hreflang: 'x-default', href: variant(DEFAULT_LOCALE) },
    ],
  };
}

/**
 * Updates document.title, meta description, OG/Twitter tags, and canonical
 * to reflect the current page. Restores originals on unmount.
 *
 * jsonLd (if provided) is injected as a <script type="application/ld+json">
 * once on mount and removed on unmount. Pass a module-level constant to avoid
 * unnecessary re-injection.
 */
export function useSEO({ title, description, url, ogImage, jsonLd, noindex }: SEOMeta) {
  const scriptRef = useRef<HTMLScriptElement | null>(null);

  useEffect(() => {
    const origTitle = document.title;
    const descEl = qs('meta[name="description"]');
    const robotsEl = qs('meta[name="robots"]');
    const ogTitleEl = qs('meta[property="og:title"]');
    const ogDescEl = qs('meta[property="og:description"]');
    const ogUrlEl = qs('meta[property="og:url"]');
    const ogImgEl = qs('meta[property="og:image"]');
    const twTitleEl = qs('meta[name="twitter:title"]');
    const twDescEl = qs('meta[name="twitter:description"]');
    const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;

    const get = (el: HTMLMetaElement | null) => el?.getAttribute('content') ?? '';
    const set = (el: HTMLMetaElement | null, v: string) => el?.setAttribute('content', v);

    const origDesc = get(descEl);
    const origRobots = get(robotsEl);
    const origOgTitle = get(ogTitleEl);
    const origOgDesc = get(ogDescEl);
    const origOgUrl = get(ogUrlEl);
    const origOgImg = get(ogImgEl);
    const origTwTitle = get(twTitleEl);
    const origTwDesc = get(twDescEl);
    const origCanonical = canonicalEl?.getAttribute('href') ?? '';

    // If no <link rel="canonical"> exists yet, create one so each SPA route
    // gets its own canonical (avoids all routes appearing to point back to /).
    let createdCanonical = false;
    let activeCanonical: HTMLLinkElement | null = canonicalEl as HTMLLinkElement | null;
    if (!activeCanonical) {
      activeCanonical = document.createElement('link') as HTMLLinkElement;
      activeCanonical.rel = 'canonical';
      document.head.appendChild(activeCanonical);
      createdCanonical = true;
    }

    // Apply
    const { canonical: canonicalUrl, alternates } = localeLinks(url);
    // hreflang: replace whatever the server/prerender put there (it may be
    // another page's set — the shell is shared) with this page's own set.
    const staleHreflang = Array.from(document.head.querySelectorAll('link[rel="alternate"][hreflang]'));
    const removedHreflang = staleHreflang.map((el) => {
      const clone = el.cloneNode(true) as HTMLLinkElement;
      el.remove();
      return clone;
    });
    const addedHreflang: HTMLLinkElement[] = [];
    if (!noindex) {
      for (const alt of alternates) {
        const link = document.createElement('link');
        link.rel = 'alternate';
        link.hreflang = alt.hreflang;
        link.href = alt.href;
        link.setAttribute(HREFLANG_ATTR, '1');
        document.head.appendChild(link);
        addedHreflang.push(link);
      }
    }
    document.title = title;
    set(descEl, description);
    if (noindex) {
      set(robotsEl, 'noindex, nofollow');
    }
    set(ogTitleEl, title);
    set(ogDescEl, description);
    set(ogUrlEl, canonicalUrl);
    if (ogImage) set(ogImgEl, ogImage);
    set(twTitleEl, title);
    set(twDescEl, description);
    activeCanonical.setAttribute('href', canonicalUrl);

    // Inject JSON-LD once (module-level constants don't change)
    if (jsonLd && !scriptRef.current) {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute('data-seo-page', '1');
      script.textContent = JSON.stringify(Array.isArray(jsonLd) ? jsonLd : [jsonLd]);
      document.head.appendChild(script);
      scriptRef.current = script;
    }

    return () => {
      document.title = origTitle;
      set(descEl, origDesc);
      if (noindex) set(robotsEl, origRobots);
      set(ogTitleEl, origOgTitle);
      set(ogDescEl, origOgDesc);
      set(ogUrlEl, origOgUrl);
      if (ogImage) set(ogImgEl, origOgImg);
      set(twTitleEl, origTwTitle);
      set(twDescEl, origTwDesc);
      for (const el of addedHreflang) el.remove();
      for (const el of removedHreflang) document.head.appendChild(el);
      if (createdCanonical && activeCanonical && document.head.contains(activeCanonical)) {
        document.head.removeChild(activeCanonical);
      } else {
        activeCanonical?.setAttribute('href', origCanonical);
      }
      if (scriptRef.current) {
        document.head.removeChild(scriptRef.current);
        scriptRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, url, ogImage, noindex]);
}
