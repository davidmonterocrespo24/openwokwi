/**
 * EditorMenuBar — File / Edit menus for the editor header.
 *
 * The editor grew a single toolbar row where every action, frequent or
 * rare, competed for the same pixels; on small screens the buttons
 * measurably overlapped. The classic fix is the classic desktop split:
 * things you do every minute stay as buttons (Run, Stop, board, Add),
 * things you do a few times per session move into menus. This is those
 * menus.
 *
 * Actions are invoked through the editorCommands registry — their real
 * owners (EditorPage, FileExplorer, EditorToolbar, SimulatorCanvas)
 * register handlers on mount, so nothing here duplicates logic and an
 * item whose owner is not mounted renders disabled. Undo/redo read the
 * canvas history from the store directly, mirroring the canvas buttons.
 *
 * Menubar behaviour follows the desktop convention: click opens, click
 * again closes, hovering a sibling while open switches menus, Escape and
 * outside clicks close.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useOscilloscopeStore } from '../../store/useOscilloscopeStore';
import { LOCALES, LOCALE_META, type Locale } from '../../i18n/config';
import { getLocaleFromPath, switchLocale } from '../../i18n/path';
import {
  hasEditorCommand,
  runEditorCommand,
  subscribeEditorCommands,
  getEditorCommandsVersion,
  type EditorCommandId,
} from '../../lib/editorCommands';
import './EditorMenuBar.css';

type Item =
  | { kind: 'command'; id: EditorCommandId; label: string; shortcut?: string; pro?: boolean }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'separator' };

// Same links the desktop app's Help menu opens (pro/desktop menu.rs) — the
// web editor mirrors that structure so both feel like one product. They
// replace the marketing nav this header no longer shows, opening in a new
// tab so the editor (and any unsaved work) stays put.
const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const DISCORD_URL = 'https://discord.gg/3mARjJrh4E';
// In the OSS build the marketing pages live on velxio.dev, not in this app
// (the overlay registers them only in pro builds) — link absolute, exactly
// like the desktop app's Help menu does.
const SITE = import.meta.env.VITE_PRO_BUILD ? '' : 'https://velxio.dev';

export const EditorMenuBar: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'file' | 'edit' | 'view' | 'account' | 'help' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Re-render when owners (un)register their commands.
  useSyncExternalStore(subscribeEditorCommands, getEditorCommandsVersion);

  const location = useLocation();
  const navigate = useNavigate();
  const currentLocale = getLocaleFromPath(location.pathname);
  const serialOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const toggleSerialMonitor = useSimulatorStore((s) => s.toggleSerialMonitor);
  const scopeOpen = useOscilloscopeStore((s) => s.open);
  const toggleOscilloscope = useOscilloscopeStore((s) => s.toggleOscilloscope);
  const undo = useSimulatorStore((s) => s.undo);
  const redo = useSimulatorStore((s) => s.redo);
  const history = useSimulatorStore((s) => s.history);
  const historyIndex = useSimulatorStore((s) => s.historyIndex);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fileItems: Item[] = [
    { kind: 'command', id: 'project.new', label: t('editor.menu.newProject', 'New workspace') },
    { kind: 'command', id: 'file.new', label: t('editor.menu.newFile', 'New file') },
    { kind: 'separator' },
    { kind: 'command', id: 'project.open', label: t('editor.menu.open', 'Open project…') },
    {
      kind: 'command',
      id: 'project.save',
      label: t('editor.menu.save', 'Save project'),
      shortcut: 'Ctrl+S',
    },
    { kind: 'separator' },
    { kind: 'command', id: 'project.import', label: t('editor.toolbar.importLabel', 'Import project') },
    { kind: 'command', id: 'project.export', label: t('editor.toolbar.exportLabel', 'Export project (.zip)') },
    { kind: 'command', id: 'project.exportBom', label: t('editor.toolbar.exportBomLabel', 'Bill of Materials (CSV)'), pro: true },
    {
      kind: 'command',
      id: 'project.exportScreenshot',
      label: t('editor.toolbar.exportScreenshotLabel', 'Schematic image (PNG)'),
      pro: true,
    },
    { kind: 'separator' },
    // The toolbar's "..." menu folded in here — same actions, same PRO
    // pills, one button fewer in the strip.
    { kind: 'command', id: 'project.share', label: t('editor.toolbar.shareLabel', 'Share / Embed') },
    { kind: 'command', id: 'project.githubSync', label: t('editor.toolbar.githubSyncLabel', 'Sync to GitHub'), pro: true },
    { kind: 'command', id: 'firmware.upload', label: t('editor.toolbar.uploadFirmwareLabel', 'Upload firmware') },
    { kind: 'command', id: 'sim.record', label: t('editor.toolbar.recordLabel', 'Record simulation'), pro: true },
  ];

  const helpItems: Item[] = [
    { kind: 'link', href: `${SITE}/docs`, label: t('header.nav.documentation', 'Documentation') },
    { kind: 'link', href: '/examples', label: t('header.nav.examples', 'Examples') },
    { kind: 'link', href: `${SITE}/pricing`, label: t('header.nav.pricing', 'Pricing') },
    { kind: 'separator' },
    { kind: 'link', href: SITE || '/', label: t('editor.menu.home', 'Velxio Home') },
    { kind: 'link', href: `${SITE}/blog/`, label: t('header.nav.blog', 'Blog') },
    { kind: 'link', href: `${SITE}/about`, label: t('editor.menu.about', 'About Velxio') },
    { kind: 'separator' },
    { kind: 'link', href: DISCORD_URL, label: t('editor.menu.discord', 'Discord Community') },
    { kind: 'link', href: GITHUB_URL, label: t('editor.menu.github', 'GitHub Repository') },
  ];

  // Edit is undo/redo only (they render specially, with live history state);
  // everything view-shaped lives in the View menu, like the desktop app.
  const editItems: Item[] = [];

  const viewItems: Item[] = [
    { kind: 'command', id: 'sim.compile', label: t('editor.menu.compile', 'Compile'), shortcut: 'Ctrl+B' },
    { kind: 'command', id: 'sim.run', label: t('editor.menu.run', 'Run') },
    { kind: 'command', id: 'sim.stop', label: t('editor.toolbar.stop', 'Stop') },
    { kind: 'command', id: 'sim.resetBoard', label: t('editor.toolbar.reset', 'Reset') },
    { kind: 'separator' },
    { kind: 'command', id: 'view.toggleExplorer', label: t('editor.menu.toggleExplorer', 'File Explorer') },
    { kind: 'command', id: 'view.toggleConsole', label: t('editor.menu.toggleConsole', 'Output Console') },
    { kind: 'separator' },
    { kind: 'command', id: 'view.reset', label: t('editor.menu.centerView', 'Center canvas view') },
    { kind: 'command', id: 'view.zoomIn', label: t('editor.canvas.zoomIn', 'Zoom in') },
    { kind: 'command', id: 'view.zoomOut', label: t('editor.canvas.zoomOut', 'Zoom out') },
  ];

  const renderLink = (item: Extract<Item, { kind: 'link' }>): React.ReactNode => (
    <a
      key={item.href}
      role="menuitem"
      className="emb-item"
      href={item.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => setOpen(null)}
    >
      <span>{item.label}</span>
    </a>
  );

  const renderCommand = (item: Extract<Item, { kind: 'command' }>): React.ReactNode => (
    <button
      key={item.id}
      role="menuitem"
      className="emb-item"
      disabled={!hasEditorCommand(item.id)}
      onClick={() => {
        setOpen(null);
        runEditorCommand(item.id);
      }}
    >
      <span>
        {item.label}
        {item.pro && <span className="emb-pro">PRO</span>}
      </span>
      {item.shortcut && <span className="emb-shortcut">{item.shortcut}</span>}
    </button>
  );

  const menu = (which: 'file' | 'edit' | 'view' | 'account' | 'help', label: string, items: Item[]): React.ReactNode => (
    <div className="emb-root" key={which}>
      <button
        className={`emb-trigger${open === which ? ' emb-trigger-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open === which}
        onClick={() => setOpen((cur) => (cur === which ? null : which))}
        onMouseEnter={() => setOpen((cur) => (cur && cur !== which ? which : cur))}
      >
        {label}
      </button>
      {open === which && (
        <div className="emb-menu" role="menu">
          {which === 'view' && (
            <>
              <button
                role="menuitemcheckbox"
                aria-checked={serialOpen}
                className="emb-item"
                onClick={() => {
                  setOpen(null);
                  toggleSerialMonitor();
                }}
              >
                <span>{t('editor.canvas.toggleSerialMonitor', 'Serial Monitor')}</span>
                <span className="emb-shortcut">{serialOpen ? '✓' : ''}</span>
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={scopeOpen}
                className="emb-item"
                onClick={() => {
                  setOpen(null);
                  toggleOscilloscope();
                }}
              >
                <span>{t('editor.menu.toggleScope', 'Oscilloscope / Logic Analyzer')}</span>
                <span className="emb-shortcut">{scopeOpen ? '✓' : ''}</span>
              </button>
              <div className="emb-separator" />
            </>
          )}
          {which === 'account' && (
            <>
              {/* Pro account items (PRO badge, Subscribe / Manage
                  subscription, licenses, history, replays, Privacy) mount
                  here via the SAME user-menu slot the bottom-left account
                  dropdown uses — one overlay renderer, two hosts. Clicking
                  any of them closes this menu (they navigate or open their
                  own modal). Empty in OSS builds. */}
              <div
                data-velxio-slot="user-menu"
                style={{ display: 'contents' }}
                onClick={() => setOpen(null)}
              />
              <div className="emb-separator" />
              {/* Language moved in here from its own top-level menu — the
                  menubar was one trigger too wide once the AI chat docks. */}
              <div className="emb-section-label">
                {t('editor.menu.language', 'Language')}
              </div>
              {LOCALES.map((loc) => (
                <button
                  key={loc}
                  role="menuitemradio"
                  aria-checked={currentLocale === loc}
                  className="emb-item"
                  onClick={() => {
                    setOpen(null);
                    if (loc === currentLocale) return;
                    navigate(
                      switchLocale(location.pathname, loc as Locale) +
                        location.search +
                        location.hash,
                    );
                  }}
                >
                  <span>{LOCALE_META[loc].nativeName}</span>
                  <span className="emb-shortcut">{currentLocale === loc ? '✓' : ''}</span>
                </button>
              ))}
            </>
          )}
          {which === 'edit' && (
            <>
              <button
                role="menuitem"
                className="emb-item"
                disabled={historyIndex < 0}
                onClick={() => {
                  setOpen(null);
                  undo();
                }}
              >
                <span>{t('editor.menu.undo', 'Undo')}</span>
                <span className="emb-shortcut">Ctrl+Z</span>
              </button>
              <button
                role="menuitem"
                className="emb-item"
                disabled={historyIndex >= history.length - 1}
                onClick={() => {
                  setOpen(null);
                  redo();
                }}
              >
                <span>{t('editor.menu.redo', 'Redo')}</span>
                <span className="emb-shortcut">Ctrl+Y</span>
              </button>
            </>
          )}
          {items.map((item, i) =>
            item.kind === 'separator' ? (
              <div key={`sep-${i}`} className="emb-separator" />
            ) : item.kind === 'link' ? (
              renderLink(item)
            ) : (
              renderCommand(item)
            ),
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="editor-menubar" ref={rootRef}>
      {menu('file', t('editor.menu.file', 'File'), fileItems)}
      {menu('edit', t('editor.menu.edit', 'Edit'), editItems)}
      {menu('view', t('editor.menu.view', 'View'), viewItems)}
      {menu('account', t('editor.menu.account', 'Account'), [])}
      {menu('help', t('editor.menu.help', 'Help'), helpItems)}
    </div>
  );
};
