/**
 * Top-level locale wiring. Sits inside `<Router>` and reacts to URL
 * changes by:
 *   1. Telling i18next to use the locale that the URL implies.
 *   2. Loading the locale's resource bundle on demand (English is preloaded).
 *   3. Persisting the locale to the `velxio_locale` cookie so the blog at
 *      velxio.dev/blog/ picks it up on the next navigation.
 *   4. Mirroring the locale onto `<html lang>` and `dir`.
 *
 * Should wrap the entire `<Routes>` tree.
 */

import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { i18n, loadLocale } from "./index";
import { LOCALE_META, DEFAULT_LOCALE, type Locale } from "./config";
import { getLocaleFromPath, switchLocale } from "./path";
import { writeLocaleCookie } from "./cookie";

type Props = { children: ReactNode };

export function LocaleSync({ children }: Props) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const target = getLocaleFromPath(pathname);

  // Locale switching for UI that lives OUTSIDE the Router: the pro account
  // menu is injected into its own React root, so it cannot call
  // useNavigate() — its language rows dispatch this event instead, and the
  // switch happens here as a normal SPA navigation (no reload, workspace
  // intact). Same path the header globe takes.
  useEffect(() => {
    const onSwitch = (e: Event): void => {
      const locale = (e as CustomEvent<{ locale?: string }>).detail?.locale;
      if (!locale) return;
      const next = switchLocale(window.location.pathname, locale as Locale);
      navigate(next + window.location.search + window.location.hash);
    };
    window.addEventListener('velxio-locale-switch', onSwitch);
    return () => window.removeEventListener('velxio-locale-switch', onSwitch);
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (i18n.language !== target) {
        await loadLocale(target);
        if (cancelled) return;
        await i18n.changeLanguage(target);
      }
      writeLocaleCookie(target);
      const meta = LOCALE_META[target] ?? LOCALE_META[DEFAULT_LOCALE];
      document.documentElement.lang = meta.htmlLang;
      document.documentElement.dir = meta.dir;
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  return <>{children}</>;
}
