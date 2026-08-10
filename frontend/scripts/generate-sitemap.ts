/**
 * Auto-generates public/sitemap.xml from seoRoutes.ts
 * Run: npx tsx scripts/generate-sitemap.ts
 * Integrated into: npm run build (via generate:sitemap)
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Import the single source of truth
import { SEO_ROUTES } from '../src/seoRoutes';

const __dirname_resolved = dirname(fileURLToPath(import.meta.url));

const DOMAIN = 'https://velxio.dev';
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// The OSS build serves only the editor surface; its sitemap must not list
// marketing URLs that 404 on a self-hosted instance. Pro builds (velxio.dev)
// list everything, exactly as before.
const OSS_SERVED = new Set(['/editor', '/examples']);
const isProBuild = !!process.env.VITE_PRO_BUILD;
const indexableRoutes = SEO_ROUTES.filter(
  (r) => !r.noindex && (isProBuild || OSS_SERVED.has(r.path)),
);

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${indexableRoutes
  .map(
    (r) => `
  <url>
    <loc>${DOMAIN}${r.path}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>${r.changefreq ?? 'monthly'}</changefreq>
    <priority>${r.priority ?? 0.5}</priority>
  </url>`
  )
  .join('')}

</urlset>
`;

const outPath = resolve(__dirname_resolved, '../public/sitemap.xml');
writeFileSync(outPath, xml.trimStart(), 'utf-8');
console.log(`sitemap.xml generated → ${indexableRoutes.length} URLs (${TODAY})`);

// Also ping Google & Bing sitemap endpoints (non-blocking, best-effort)
const SITEMAP_URL = `${DOMAIN}/sitemap.xml`;
const PING_URLS = [
  `https://www.google.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`,
  `https://www.bing.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`,
];

if (process.argv.includes('--ping')) {
  console.log('Pinging search engines...');
  Promise.allSettled(
    PING_URLS.map(async (url) => {
      try {
        const res = await fetch(url);
        console.log(`  ${res.ok ? 'OK' : 'FAIL'} ${url.split('?')[0]}`);
      } catch (e: any) {
        console.log(`  FAIL ${url.split('?')[0]}: ${e.message}`);
      }
    })
  );
}
