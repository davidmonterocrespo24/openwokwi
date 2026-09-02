import { useTranslation } from 'react-i18next';
import { useThemeMode } from '../../hooks/useTheme';
import { resolveMode } from '../../lib/theme';

/**
 * One-click light/dark switch for the editor toolbar and the site header.
 *
 * Deliberately two-state. The preference has three values (dark / light /
 * system) but a button that cycles three states leaves the user guessing
 * what the next click does, so this one always sets an EXPLICIT mode — it
 * flips to whatever the current appearance is not, including out of
 * "system". "Match system" is picked from the View ▸ Appearance menu, which
 * is where a three-way choice belongs.
 *
 * The icon shows the destination, not the current state: a sun means
 * "switch to light".
 */
export const ThemeToggle = ({ className = '' }: { className?: string }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useThemeMode();
  const resolved = resolveMode(mode);
  const next = resolved === 'dark' ? 'light' : 'dark';

  const label =
    next === 'light'
      ? t('editor.toolbar.themeToLight', 'Switch to light theme')
      : t('editor.toolbar.themeToDark', 'Switch to dark theme');

  return (
    <button
      type="button"
      className={`tb-btn tb-btn-theme ${className}`.trim()}
      onClick={() => setMode(next)}
      title={label}
      aria-label={label}
    >
      {next === 'light' ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
};
