/**
 * react-i18next bootstrap. Loads the English source bundle synchronously and
 * lazy-imports the other locales on demand so the initial paint stays small
 * (each non-default JSON adds a few KB; loading 8 of them up front would
 * pad the bundle without payoff for English-speaking visitors).
 *
 * The active locale is determined in priority order:
 *   1. URL prefix (`/es/...`) — the source of truth, what crawlers see.
 *   2. velxio_locale cookie — sticky preference, shared with the blog.
 *   3. Browser languages — Accept-Language fallback.
 *   4. DEFAULT_LOCALE ("en") — last resort.
 *
 * The URL is the source of truth at runtime; the cookie only seeds the
 * very first navigation so a returning visitor lands on their language
 * without a redirect.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enCommon2 from "./locales/en/common2.json";
import enReleases from "./locales/en/releases.json";
import enDocs from "./locales/en/docs.json";
import enDocs2 from "./locales/en/docs2.json";
import enSeo from "./locales/en/seo.json";
import enSeo2 from "./locales/en/seo2.json";
import enSeo3 from "./locales/en/seo3.json";
import enSeo4 from "./locales/en/seo4.json";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./config";

/**
 * Deep merge for locale resource files. The namespace used to be built
 * with a SHALLOW spread, so a top-level section present in two files had
 * the later file silently clobber the earlier one wholesale: common2's
 * `editor` erased common.json's `editor.share.*` (the Share modal's
 * visibility labels rendered as raw keys), and the same collision on
 * `header` later wiped `header.auth.*` — the account menu showed
 * "header.auth.signOut". Merging by key ends the failure class.
 */
function deepMerge(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const prev = out[k];
    if (
      prev && v &&
      typeof prev === "object" && typeof v === "object" &&
      !Array.isArray(prev) && !Array.isArray(v)
    ) {
      out[k] = deepMerge(
        prev as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

const NAMESPACES = ["common"] as const;
type Namespace = (typeof NAMESPACES)[number];

const SUPPORTED_LANGS = LOCALES as readonly string[];

// Init is synchronous for the default locale (resources are inlined via
// the static import above), so we don't need to await the returned
// Promise for first-paint correctness. Awaiting it would force the
// project's tsconfig to enable top-level-await for ESM, which we're
// avoiding to keep build settings minimal.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: {
          ...deepMerge(deepMerge(enCommon, enCommon2), enReleases),
          seo: {
            ...enSeo.seo,
            ...enSeo2.seo,
            ...enSeo3.seo,
            ...enSeo4.seo,
          },
          docs: { ...enDocs.docs, ...enDocs2.docs },
        },
      },
    },
    // Start at the default locale (its resources are inlined above). The
    // active locale is then driven from the URL by LocaleSync after mount,
    // which lazy-loads the matching bundle and performs a real
    // changeLanguage — the event that makes subscribed components re-render.
    // Seeding `lng` to the URL locale here instead left direct loads of a
    // non-default URL stuck on the English fallback, because LocaleSync's
    // `i18n.language !== target` guard was already satisfied so the bundle
    // was never fetched.
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LANGS,
    // Our locale codes are lowercase with a lowercase region ("zh-cn",
    // "pt-br"). i18next's default code formatting rewrites those to
    // "zh-CN" / "pt-BR", which then fail the `supportedLngs` check and get
    // dropped from the resolve hierarchy — leaving only the English
    // fallback, so those two locales never resolved their own bundle.
    // Forcing lowercase keeps the codes consistent with the bundles.
    lowerCaseLng: true,
    ns: NAMESPACES,
    defaultNS: "common",
    interpolation: { escapeValue: false }, // React already escapes
    react: {
      useSuspense: false, // we register resources synchronously in dev
    },
    detection: {
      // LocaleSync makes the locale decision from the URL after mount;
      // detector is left configured for future fallback paths only.
      order: ["path", "cookie", "navigator"],
      lookupCookie: "velxio_locale",
      caches: [], // we manage the cookie in src/i18n/cookie.ts
    },
  });

/**
 * Lazy-load a non-English locale's bundle and register it with i18next.
 * Returns once the resources are available so callers can `await` it
 * before triggering i18n.changeLanguage() for instant UI swap.
 */
export async function loadLocale(locale: Locale): Promise<void> {
  if (locale === DEFAULT_LOCALE) return;
  if (i18n.hasResourceBundle(locale, "common")) return;
  const [
    commonMod,
    common2Mod,
    releasesMod,
    docsMod,
    docs2Mod,
    seoMod,
    seo2Mod,
    seo3Mod,
    seo4Mod,
  ] = await Promise.all([
    import(`./locales/${locale}/common.json`),
    import(`./locales/${locale}/common2.json`).catch(() => ({ default: {} })),
    import(`./locales/${locale}/releases.json`),
    import(`./locales/${locale}/docs.json`),
    import(`./locales/${locale}/docs2.json`),
    import(`./locales/${locale}/seo.json`).catch(() => ({ default: { seo: {} } })),
    import(`./locales/${locale}/seo2.json`).catch(() => ({ default: { seo: {} } })),
    import(`./locales/${locale}/seo3.json`).catch(() => ({ default: { seo: {} } })),
    import(`./locales/${locale}/seo4.json`).catch(() => ({ default: { seo: {} } })),
  ]);
  const docs1Body = (docsMod.default ?? docsMod).docs ?? {};
  const docs2Body = (docs2Mod.default ?? docs2Mod).docs ?? {};
  const seoBody = {
    ...((seoMod.default ?? seoMod).seo ?? {}),
    ...((seo2Mod.default ?? seo2Mod).seo ?? {}),
    ...((seo3Mod.default ?? seo3Mod).seo ?? {}),
    ...((seo4Mod.default ?? seo4Mod).seo ?? {}),
  };
  const merged = {
    ...deepMerge(
      deepMerge(commonMod.default ?? commonMod, common2Mod.default ?? common2Mod),
      releasesMod.default ?? releasesMod,
    ),
    seo: seoBody,
    docs: { ...docs1Body, ...docs2Body },
  };
  i18n.addResourceBundle(locale, "common", merged, true, true);
}

export { i18n };
export type { Locale, Namespace };
