/**
 * CustomChipDialog — the custom chip EXAMPLES GALLERY.
 *
 * Picking an example (or "start from blank") hands its chip.c + chip.json to
 * the caller, which stores them on the component; the sources then appear as
 * ordinary `chip.c` / `chip.json` files in the chip's file-explorer section
 * and are edited in the common Monaco editor like any board file. The old
 * in-modal editor tab is gone — editing and compiling happen in the editor
 * (per-chip Compile button, or Run).
 */
import { useMemo, useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  getChipExamples,
  getChipExamplesVersion,
  subscribeChipExamples,
  BLANK_CHIP,
  type ChipExample,
} from './chipExamples';

export interface CustomChipDialogProps {
  chipName: string;
  onClose: () => void;
  /** Load this example's chip.c + chip.json into the chip. */
  onPick: (example: ChipExample) => void;
}

export const CustomChipDialog = ({ chipName, onClose, onPick }: CustomChipDialogProps) => {
  const { t } = useTranslation();

  // Categories shown as section headers in the gallery. Subscribed so
  // overlay-registered examples landing after mount still render.
  const examplesVersion = useSyncExternalStore(subscribeChipExamples, getChipExamplesVersion);
  const grouped = useMemo(() => {
    const m = new Map<string, ChipExample[]>();
    for (const e of getChipExamples()) {
      if (!m.has(e.category)) m.set(e.category, []);
      m.get(e.category)!.push(e);
    }
    return Array.from(m.entries());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examplesVersion]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Portal to <body>: escape the canvas subtree so no ancestor stacking
  // context can pin the dialog below floating panels (e.g. the AI chat).
  return createPortal(
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <strong style={{ flex: 1 }}>{t('editor.customChip.title', { chipName })}</strong>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={bodyStyle}>
          <div style={{ overflow: 'auto', padding: 12, flex: 1 }}>
            <button style={blankBtn} onClick={() => onPick(BLANK_CHIP)}>
              + Start from blank
            </button>
            {grouped.map(([cat, list]) => (
              <div key={cat} style={{ marginTop: 18 }}>
                <div style={categoryStyle}>{cat.toUpperCase()}</div>
                <div style={gridStyle}>
                  {list.map((ex) => (
                    <button
                      key={ex.id}
                      style={cardBtn}
                      onClick={() => onPick(ex)}
                      title={ex.description}
                    >
                      <div style={cardName}>{ex.name}</div>
                      <div style={cardDesc}>{ex.description}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={footerStyle}>
          {/* Extension point for the velxio-prod overlay (e.g. a "Create with
              AI" button). Empty in OSS. The overlay reads `velxioCloseDialog`
              off this element to dismiss the dialog after it acts. */}
          <div
            data-velxio-slot="custom-chip-actions"
            style={{ display: 'contents' }}
            ref={(el) => {
              if (el) {
                (el as unknown as { velxioCloseDialog?: () => void }).velxioCloseDialog = onClose;
              }
            }}
          />
          <div style={{ flex: 1 }} />
          <button style={cancelBtn} onClick={onClose}>{t('editor.customChip.cancel')}</button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// ── Inline styles (matches the visual language of other Velxio modals) ──

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  // Above every floating panel, including the pro AI chat (8000/8001).
  zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const dialogStyle: React.CSSProperties = {
  width: '90vw', height: '85vh', maxWidth: 1280,
  background: 'var(--wb-2)', color: 'var(--wb-13)', borderRadius: 6,
  display: 'flex', flexDirection: 'column',
  boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
};
const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '10px 14px',
  borderBottom: '1px solid var(--wb-6)', background: 'var(--wb-3)',
};
const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--wb-11)',
  fontSize: 18, cursor: 'pointer', padding: '2px 8px',
};
const bodyStyle: React.CSSProperties = { flex: 1, overflow: 'hidden', display: 'flex' };
const footerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
  borderTop: '1px solid var(--wb-6)', background: 'var(--wb-3)',
};
const cancelBtn: React.CSSProperties = {
  padding: '6px 14px', background: 'var(--wb-7)', color: 'var(--wb-13)',
  border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 13,
};
const blankBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--wb-5)', color: 'var(--wb-13)',
  border: '1px dashed var(--wb-8)', borderRadius: 4, cursor: 'pointer',
  width: '100%', textAlign: 'left', fontSize: 13,
};
const categoryStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--wb-10)', letterSpacing: 1, marginBottom: 6,
};
const gridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8,
};
const cardBtn: React.CSSProperties = {
  padding: '10px 12px', background: 'var(--wb-5)', color: 'var(--wb-13)',
  border: '1px solid var(--wb-7)', borderRadius: 4, cursor: 'pointer',
  textAlign: 'left',
};
const cardName: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', marginBottom: 4 };
const cardDesc: React.CSSProperties = { fontSize: 11, color: 'var(--wb-11)', lineHeight: 1.4 };
