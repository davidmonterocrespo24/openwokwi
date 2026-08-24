#!/usr/bin/env node
/**
 * prerender-seo.mjs — Generates route-specific HTML for SEO-important pages.
 *
 * How it works:
 * 1. Starts a Vite dev server in SSR mode (no HTTP server, just the transform pipeline)
 * 2. Loads src/entry-server.tsx through Vite — handles TSX, CSS, SVG, path aliases
 * 3. For each route with seoMeta in seoRoutes.ts:
 *    a. Renders the React component to HTML via renderToString
 *    b. Replaces <title>, <meta>, OG/Twitter tags, canonical URL from seoMeta
 *    c. Injects the rendered HTML into #root-seo
 * 4. Writes to dist/{route}/index.html
 *
 * nginx's try_files ($uri/) serves these automatically.
 *
 * Run after `vite build`: node scripts/prerender-seo.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

// Check that dist exists (vite build must have run first)
if (!existsSync(join(distDir, 'index.html'))) {
  console.error('❌ dist/index.html not found. Run `vite build` first.');
  process.exit(1);
}

const baseHtml = readFileSync(join(distDir, 'index.html'), 'utf-8');
const DOMAIN = 'https://velxio.dev';

// nginx serves each prerendered route as `<route>/index.html` and
// 301-redirects the slash-less URL to add the trailing slash. Canonical +
// og:url must therefore use the slash form (== the served URL == the sitemap
// entry), or Google sees a canonical that points to a redirecting URL.
const withSlash = (u) => (u.endsWith('/') ? u : `${u}/`);

/**
 * Swap the whole static #root-seo block (the hand-written homepage fallback
 * in index.html) for this page's SSR body. Located by string search, not by
 * a regex anchored on a following <script>: Vite hoists the module script
 * into <head>, so in the BUILT index.html the block is followed by </body>
 * — the old regex never matched and every prerendered page shipped the
 * homepage's fallback body (same <h1>, same nav) under its own <head>.
 */
function replaceRootSeo(html, seoBody) {
  const start = html.indexOf('<div id="root-seo"');
  if (start === -1) {
    // No fallback block in this template: add ours before </body>.
    return html.replace('</body>', `<div id="root-seo" aria-hidden="true">${seoBody}</div>\n  </body>`);
  }
  const bodyEnd = html.indexOf('</body>', start);
  const end = html.lastIndexOf('</div>', bodyEnd === -1 ? html.length : bodyEnd);
  if (end === -1 || end < start) return html;
  return (
    html.slice(0, start) +
    `<div id="root-seo" aria-hidden="true">${seoBody}</div>` +
    html.slice(end + '</div>'.length)
  );
}

// ── Mock browser globals for SSR ────────────────────────────────────────────
// Zustand's persist middleware and some components access these at import time.
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    length: 0,
    key: () => null,
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'prerender-seo' };
}
if (typeof globalThis.matchMedia === 'undefined') {
  globalThis.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {} });
}

// ── Start Vite in SSR mode ──────────────────────────────────────────────────
console.log('🔧 Starting Vite SSR transform pipeline...');

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

let generated = 0;

try {
  // Load entry-server.tsx through Vite's transform pipeline
  const { getPrerenderedRoutes, render, getPrerenderedExampleRoutes, renderExample,
          loadRouteComponents } =
    await vite.ssrLoadModule('/src/entry-server.tsx');

  // Pull in the overlay's marketing pages (pro builds) before asking for
  // the route list — without this the prerender would silently cover only
  // the OSS surface.
  await loadRouteComponents();

  const routes = getPrerenderedRoutes();
  const exampleRoutes = getPrerenderedExampleRoutes();

  // hreflang for the localized (marketing/static) pages: every locale
  // variant of the route plus x-default on the locale-less English URL.
  // The SPA serves the same page translated under /<locale>/..., so each
  // variant is a real page (see useSEO.ts, which emits the same set on the
  // client, and the prod app shell, which emits it for the /<locale>/
  // variants nginx has no static file for).
  const { LOCALES, LOCALE_META, DEFAULT_LOCALE } = await vite.ssrLoadModule('/src/i18n/config.ts');
  const localizedPath = (path, locale) =>
    locale === DEFAULT_LOCALE ? path : `/${locale}${path === '/' ? '' : path}`;
  const hreflangTags = (routePath) => {
    const variant = (l) => withSlash(`${DOMAIN}${localizedPath(routePath, l)}`);
    return [
      ...LOCALES.map((l) => `<link rel="alternate" hreflang="${LOCALE_META[l].htmlLang}" href="${variant(l)}" />`),
      `<link rel="alternate" hreflang="x-default" href="${variant(DEFAULT_LOCALE)}" />`,
    ].join('\n  ');
  };
  const withHreflang = (html, routePath) =>
    html.replace('</head>', `  ${hreflangTags(routePath)}\n  </head>`);

  // Route metadata for the prod app shell (title/description per SEO route),
  // so /<locale>/<route> paths that fall through to it get the route's own
  // head instead of the homepage's.
  // Starter examples ("New <board> project" pages) for the prod app shell.
  const starters = await vite.ssrLoadModule('/src/data/starters.ts');
  writeFileSync(
    join(distDir, 'starters.json'),
    JSON.stringify(
      starters.STARTER_EXAMPLES.map((st) => ({
        id: st.id, board: st.board,
        title: starters.starterTitle(st.board),
        description: starters.starterDescription(st.board),
      })),
    ),
    'utf-8',
  );

  const { SEO_ROUTES } = await vite.ssrLoadModule('/src/seoRoutes.ts');
  writeFileSync(
    join(distDir, 'seo-routes.json'),
    JSON.stringify(
      SEO_ROUTES.filter((r) => r.seoMeta && !r.noindex).map((r) => ({
        path: r.path, title: r.seoMeta.title, description: r.seoMeta.description,
      })),
    ),
    'utf-8',
  );

  console.log(`📄 Prerendering ${routes.length} SEO pages + ${exampleRoutes.length} example pages...\n`);

  for (const route of routes) {
    const { seoMeta } = route;
    if (!seoMeta) continue;

    // Render the React component to HTML
    let bodyHtml = render(route.path);

    // Build the page HTML
    let html = baseHtml;

    // Replace <title>
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${seoMeta.title}</title>`);

    // Replace meta description
    html = html.replace(
      /<meta name="description" content="[^"]*"/,
      `<meta name="description" content="${seoMeta.description}"`
    );

    // Add/replace canonical URL
    const canonicalTag = `<link rel="canonical" href="${withSlash(seoMeta.url)}" />`;
    if (html.includes('<link rel="canonical"')) {
      html = html.replace(/<link rel="canonical"[^>]*\/>/, canonicalTag);
    } else {
      html = html.replace('</head>', `  ${canonicalTag}\n  </head>`);
    }
    // hreflang only for a page that is its own canonical; a page pointing
    // its canonical elsewhere (/v2 -> /) must not declare alternates.
    if (withSlash(seoMeta.url) === withSlash(`${DOMAIN}${route.path}`)) {
      html = withHreflang(html, route.path);
    }

    // Replace OG tags
    html = html.replace(
      /<meta property="og:title" content="[^"]*"/,
      `<meta property="og:title" content="${seoMeta.title}"`
    );
    html = html.replace(
      /<meta property="og:description" content="[^"]*"/,
      `<meta property="og:description" content="${seoMeta.description}"`
    );
    html = html.replace(
      /<meta property="og:url" content="[^"]*"/,
      `<meta property="og:url" content="${withSlash(seoMeta.url)}"`
    );

    // Replace Twitter tags
    html = html.replace(
      /<meta name="twitter:title" content="[^"]*"/,
      `<meta name="twitter:title" content="${seoMeta.title}"`
    );
    html = html.replace(
      /<meta name="twitter:description" content="[^"]*"/,
      `<meta name="twitter:description" content="${seoMeta.description}"`
    );

    // Replace #root-seo content with SSR-rendered body (or fallback to title+description)
    const seoBody = bodyHtml
      ? bodyHtml
      : `<h1>${seoMeta.title.split(' | ')[0]}</h1><p>${seoMeta.description}</p>`;

    html = replaceRootSeo(html, seoBody);

    // Write to dist/{path}/index.html
    const routePath = route.path === '/' ? '' : route.path.slice(1);
    if (routePath) {
      const dir = join(distDir, routePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), html, 'utf-8');
    } else {
      // Root — update dist/index.html in place
      writeFileSync(join(distDir, 'index.html'), html, 'utf-8');
    }

    generated++;
    const ssrStatus = bodyHtml ? '✓' : '⚠ (meta only)';
    console.log(`  ${ssrStatus} ${route.path}`);
  }

  // ── Prerender example detail pages ──────────────────────────────────────────
  console.log('\n📦 Prerendering example pages...\n');
  let examplesGenerated = 0;

  for (const exRoute of exampleRoutes) {
    const exampleId = exRoute.path.split('/').pop();
    let bodyHtml = renderExample(exampleId);

    let html = baseHtml;

    html = html.replace(/<title>[^<]*<\/title>/, `<title>${exRoute.title}</title>`);
    html = html.replace(
      /<meta name="description" content="[^"]*"/,
      `<meta name="description" content="${exRoute.description}"`
    );

    const canonicalTag = `<link rel="canonical" href="${withSlash(exRoute.url)}" />`;
    if (html.includes('<link rel="canonical"')) {
      html = html.replace(/<link rel="canonical"[^>]*\/>/, canonicalTag);
    } else {
      html = html.replace('</head>', `  ${canonicalTag}\n  </head>`);
    }

    html = html.replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${exRoute.title}"`);
    html = html.replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${exRoute.description}"`);
    html = html.replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${withSlash(exRoute.url)}"`);
    html = html.replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${exRoute.title}"`);
    html = html.replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${exRoute.description}"`);

    const seoBody = bodyHtml || `<h1>${exRoute.title.split(' — ')[0]}</h1><p>${exRoute.description}</p>`;
    html = replaceRootSeo(html, seoBody);

    const dir = join(distDir, 'examples', exampleId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html, 'utf-8');

    examplesGenerated++;
    const ssrStatus = bodyHtml ? '✓' : '⚠ (meta only)';
    if (examplesGenerated <= 5 || examplesGenerated % 20 === 0) {
      console.log(`  ${ssrStatus} /examples/${exampleId}`);
    }
  }
  if (exampleRoutes.length > 5) {
    console.log(`  ... (${examplesGenerated} total)`);
  }
  generated += examplesGenerated;

  // Also ensure root index.html has a canonical tag
  let rootHtml = readFileSync(join(distDir, 'index.html'), 'utf-8');
  const rootCanonical = `<link rel="canonical" href="${DOMAIN}/" />`;
  if (!rootHtml.includes('<link rel="canonical"')) {
    rootHtml = rootHtml.replace('</head>', `  ${rootCanonical}\n  </head>`);
    writeFileSync(join(distDir, 'index.html'), rootHtml, 'utf-8');
  }

} finally {
  await vite.close();
}

console.log(`\n✅ Prerendered ${generated} SEO pages with SSR content`);
