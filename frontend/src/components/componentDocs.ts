/**
 * Component Markdown docs — lazy registry.
 *
 * Human-authored datasheets live in `./component-docs/<category>/<id>.md`
 * (organised by type for tidiness). Each file is matched by its basename
 * (`<id>`) so a doc resolves regardless of which category folder it is filed
 * under — moving `led.md` from `output/` to `misc/` doesn't break the link.
 *
 * A doc may open with a small YAML-ish front-matter block carrying the
 * component's brand and a purchase link:
 *
 *     ---
 *     brand: Aosong (AM2302)
 *     buy: https://www.example.com/dht22
 *     ---
 *     Body markdown…
 *
 * The raw Markdown is loaded on demand (Vite `?raw` + dynamic import) and
 * cached, so the ~150-file corpus never touches the initial bundle and each
 * doc is fetched at most once. See `component-docs/README.md` for the authoring
 * format and how the hover panel consumes it.
 */

export interface ComponentDoc {
  /** Markdown body with the front-matter stripped. */
  body: string;
  /** Manufacturer / brand, from front-matter. */
  brand?: string;
  /** Purchase URL, from front-matter (validated http(s) before use in the UI). */
  buy?: string;
}

const modules = import.meta.glob('./component-docs/**/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

// basename (component id, no extension) -> raw-markdown loader
const byId: Record<string, () => Promise<string>> = {};
for (const path in modules) {
  const id = path.split('/').pop()!.replace(/\.md$/, '');
  byId[id] = modules[path];
}

const cache = new Map<string, ComponentDoc | null>();

/**
 * Overlay seam: a private build (velxio.com) can register the datasheet
 * markdown for a component it injects at runtime — the import.meta.glob above
 * only sees files committed in this tree. Same raw format as the .md files
 * (optional front-matter + body). Last write wins; the parsed cache for the
 * id is invalidated so a re-render picks the new doc up.
 */
export function registerComponentDoc(id: string, raw: string): void {
  byId[id] = () => Promise.resolve(raw);
  cache.delete(id);
}

/**
 * Decorate a datasheet Buy/Product-page URL with UTM attribution so the
 * vendor sees the referral came from Velxio. `componentId` lands in
 * utm_content so partner dashboards can tell WHICH part drove the visit.
 * Existing query params on the vendor URL are preserved.
 */
export function productPageHref(url: string, componentId: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', 'velxio');
    u.searchParams.set('utm_medium', 'simulator');
    u.searchParams.set('utm_campaign', 'datasheet');
    u.searchParams.set('utm_content', componentId);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Split an optional `---`-delimited front-matter block off the top of a
 * Markdown string. Only a leading block counts, so table separators
 * (`| --- |`) and thematic breaks inside the body are never mistaken for it.
 * The parser is deliberately tiny (flat `key: value` pairs only).
 */
function parseDoc(raw: string): ComponentDoc {
  // The closing fence must be a line of exactly `---` (optional trailing
  // spaces) terminated by EOL or EOF — `(?:\r?\n|$)` — so a body line that
  // merely starts with dashes (`--- notes`, `----`) is never mistaken for it.
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { body: raw };

  const body = raw.slice(m[0].length);
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    // Strip only a *matched* surrounding quote pair, so a value with a single
    // edge quote is left intact rather than mangled.
    const val = line
      .slice(idx + 1)
      .trim()
      .replace(/^"([\s\S]*)"$/, '$1')
      .replace(/^'([\s\S]*)'$/, '$1');
    if (key) meta[key] = val;
  }
  return { body, brand: meta.brand || undefined, buy: meta.buy || undefined };
}

/** True if an authored datasheet exists for this component id. */
export function hasDoc(id: string): boolean {
  return id in byId;
}

/** Load (and cache) the parsed datasheet for a component id, or null if none. */
export async function loadDoc(id: string): Promise<ComponentDoc | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  const loader = byId[id];
  if (!loader) {
    cache.set(id, null);
    return null;
  }
  try {
    const parsed = parseDoc(await loader());
    cache.set(id, parsed);
    return parsed;
  } catch {
    cache.set(id, null);
    return null;
  }
}
