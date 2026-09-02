/**
 * Modal that surfaces results from `verifyCircuit()` before a Run.
 *
 *   - Errors  → blocking: user must pick Run Anyway or Cancel.
 *   - Warnings → non-blocking summary so the user can still review them
 *     even when there are no errors (we don't render the modal in that
 *     case — a setMessage banner does the job).
 *
 * The component is dumb: it just renders the verification result it's
 * given. The caller (EditorToolbar) decides when to show it.
 */
import { createPortal } from 'react-dom';
import type { CircuitWarning, VerificationResult } from '../../simulation/verify/circuitVerifier';

interface Props {
  result: VerificationResult;
  onCancel: () => void;
  onRunAnyway: () => void;
}

const SEVERITY_COPY: Record<CircuitWarning['severity'], { label: string; color: string }> = {
  error: { label: 'Error', color: '#e74c3c' },
  warning: { label: 'Warning', color: '#f1c40f' },
};

export const CircuitVerificationModal: React.FC<Props> = ({ result, onCancel, onRunAnyway }) => {
  const items: CircuitWarning[] = [...result.errors, ...result.warnings];
  // Portaled to <body>: see LibraryManagerModal - the toolbar's
  // container-type would otherwise shrink this fixed overlay.
  return createPortal(
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>Circuit verification</h2>
        <p style={styles.subtitle}>
          {result.errors.length === 0
            ? `${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} found.`
            : `${result.errors.length} error${result.errors.length === 1 ? '' : 's'} and ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} found. Running anyway is at your own risk.`}
        </p>
        <ul style={styles.list}>
          {items.map((it, i) => (
            <li key={i} style={styles.row}>
              <span
                style={{
                  ...styles.badge,
                  background: SEVERITY_COPY[it.severity].color,
                }}
              >
                {SEVERITY_COPY[it.severity].label}
              </span>
              <span style={styles.message}>
                {it.componentId ? (
                  <strong style={styles.componentId}>{it.componentId}: </strong>
                ) : null}
                {it.message}
              </span>
            </li>
          ))}
        </ul>
        <div style={styles.actions}>
          <button onClick={onCancel} style={styles.primaryBtn}>
            Cancel
          </button>
          <button onClick={onRunAnyway} style={styles.secondaryBtn}>
            Run anyway
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // Above the agent side panel (z 8000): a modal is always the top task.
    zIndex: 9000,
  },
  modal: {
    background: 'var(--wb-3)',
    border: '1px solid var(--wb-7)',
    borderRadius: 8,
    padding: '1.5rem',
    width: 560,
    maxHeight: '80vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  title: { color: 'var(--wb-13)', margin: 0, fontSize: 18, fontWeight: 600 },
  subtitle: { color: 'var(--wb-11)', margin: 0, fontSize: 13, lineHeight: 1.4 },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 10px',
    background: 'var(--wb-2)',
    border: '1px solid var(--wb-6)',
    borderRadius: 4,
    fontSize: 13,
    lineHeight: 1.4,
    color: 'var(--wb-12)',
  },
  badge: {
    color: 'var(--wb-2)',
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    flexShrink: 0,
    marginTop: 1,
  },
  message: { flex: 1 },
  componentId: { color: 'var(--color-accent-fg)', fontFamily: 'monospace' },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  primaryBtn: {
    background: '#0e639c',
    color: 'var(--color-fg-on-action)',
    border: 'none',
    padding: '8px 16px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  secondaryBtn: {
    background: 'transparent',
    color: 'var(--wb-12)',
    border: '1px solid var(--wb-8)',
    padding: '8px 16px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
  },
};
