/**
 * Pro board-gate registry.
 *
 * STM32 and the QEMU-backed Raspberry Pi family are Pro-only emulation
 * features. The OSS app knows *which* boards are Pro (public information —
 * `isProBoardKind`) and renders a PRO badge for them, but it does NOT know
 * the current user's entitlement. The pro overlay installs the real gate via
 * `installBoardGateImpl`, deciding whether a given action on a board is
 * allowed for the signed-in user on the web.
 *
 * Two actions go through the gate, and the overlay may answer them
 * differently:
 *
 *   - 'add'  the board is placed on the canvas (picker, new-project dialog).
 *            Placing costs nothing — the emulator is not involved — so an
 *            overlay can let anyone build and save a circuit around a Pro
 *            board and sell the run instead of the drawing.
 *   - 'run'  the board is started. This is the action that reaches an
 *            emulator, and the one a free tier is measured against.
 *
 * A 'block' verdict may carry the words for the prompt (`featureName`,
 * `description`, `requiredPlan`, `cta`) so the overlay can say *why* — a
 * quota that ran out reads differently from a feature that was never free —
 * without the OSS tree learning anything about plans or quotas.
 *
 * Mirrors the other OSS->Pro seams (`proSaveAction.ts`, `proSession.ts`,
 * `proRoutes.ts`): the OSS app defines a stable doorbell; the overlay plugs in.
 *
 *   - OSS without an overlay  -> default impl returns 'allow'. Self-hosted
 *     deployments don't block in the UI: the board can be placed and the
 *     project stays loadable, but nothing starts. Since 2026-09-06 the
 *     emulators themselves are not in this repo at all (they live in the
 *     optional app.pro_boards backend package), so the simulation route
 *     answers start_pi / start_stm32 with board_access.PRO_BOARD_MESSAGE.
 *     Availability is a backend answer, never a UI lie.
 *   - With the pro overlay     -> installBoardGateImpl() decides per action
 *     for a non-paid user on the web, and the caller fires the upgrade
 *     prompt with the verdict's words.
 *   - Desktop (Tauri)          -> overlay returns 'allow'; the per-board QEMU
 *     download prompt (Stm32QemuPrompt / RaspberryPiQemuPrompt) handles it.
 *
 * The backend is the authority for a run either way: when the server refuses
 * a start (`error` on the simulation socket), the store reports it through
 * `reportBoardRunRefused`, which dispatches BOARD_RUN_REFUSED_EVENT so an
 * overlay can refresh whatever it keyed its verdict on and prompt in place.
 */

import type { BoardKind } from '../types/board';
import { isPiBoardKind, isStm32BoardKind } from '../types/board';
import { getProBoard } from './proBoardRegistry';

export type BoardGateDecision = 'allow' | 'block';

/** What is being asked of the board: placing it, or starting it. */
export type BoardGateAction = 'add' | 'run';

/**
 * A 'block' with the words for the prompt. Every field is optional: a bare
 * 'block' string keeps the historical prompt (`proBoardFeatureName`).
 */
export interface BoardGateBlock {
  decision: 'block';
  /** Headline subject ("STM32 emulation"). Defaults to proBoardFeatureName. */
  featureName?: string;
  /** Second line of the prompt — the reason this particular run is refused. */
  description?: string;
  /** Cheapest plan that lifts the block. */
  requiredPlan?: 'maker' | 'pro';
  /** Which primary action the prompt offers: upgrade (default) or sign in. */
  cta?: 'pricing' | 'signin';
}

export type BoardGateVerdict = { decision: 'allow' } | BoardGateBlock;

/**
 * Static, public predicate: which board kinds are Pro emulation features.
 * Used for the PRO badge (always shown for these) and as the precondition the
 * overlay's gate checks. STM32 (libqemu-arm) + every QEMU Raspberry Pi
 * (Zero/1/2/3/4/5; excludes the Pico, which is browser emulation).
 */
export function isProBoardKind(kind: BoardKind | string): boolean {
  return isStm32BoardKind(kind) || isPiBoardKind(kind);
}

type BoardGateImpl = (
  kind: BoardKind,
  action: BoardGateAction,
) => BoardGateDecision | BoardGateVerdict;

let _impl: BoardGateImpl | null = null;

/** Installed by the pro overlay (mountPro). Pass null to clear (hot reload). */
export function installBoardGateImpl(impl: BoardGateImpl | null): void {
  _impl = impl;
}

/** Whether the pro overlay has installed a gate (else OSS default applies). */
export function hasBoardGateImpl(): boolean {
  return _impl !== null;
}

/**
 * Full verdict for `action` on a board of `kind`. Non-Pro boards are always
 * allowed. For Pro boards, the overlay's impl decides; with no overlay the
 * OSS default is 'allow'. A string answer from the impl is normalised so
 * every caller sees the object form.
 */
export function boardGateVerdict(kind: BoardKind, action: BoardGateAction): BoardGateVerdict {
  if (!isProBoardKind(kind)) return { decision: 'allow' };
  if (!_impl) return { decision: 'allow' };
  try {
    const raw = _impl(kind, action);
    if (raw === 'allow') return { decision: 'allow' };
    if (raw === 'block') return { decision: 'block' };
    return raw;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] board-gate impl threw:', err);
    return { decision: 'allow' };
  }
}

/**
 * Decide whether `action` on a board of `kind` is allowed for the current
 * user — the boolean view of `boardGateVerdict`. `action` defaults to 'run',
 * the action every historical caller meant.
 */
export function boardGateDecision(kind: BoardKind, action: BoardGateAction = 'run'): BoardGateDecision {
  return boardGateVerdict(kind, action).decision;
}

/**
 * One-call form for the UI: evaluate the gate and, when it blocks, fire the
 * upgrade prompt with the verdict's words. Returns true when the caller
 * must stop. Keeps the three call sites (picker add, new-project add, run
 * backstop) from each re-deriving the prompt.
 */
export function blockedByBoardGate(kind: BoardKind, action: BoardGateAction): boolean {
  const verdict = boardGateVerdict(kind, action);
  if (verdict.decision === 'allow') return false;
  triggerProUpgradePrompt(verdict.featureName ?? proBoardFeatureName(kind), verdict);
  return true;
}

/**
 * Fire the Pro upgrade prompt. Dispatches the same CustomEvent the pro
 * overlay's UpgradeGate listens for (`PRO_UPGRADE_EVENT` in
 * proComponentInjector.ts). The event name is the stable contract — the OSS
 * app does not import from the overlay.
 */
const PRO_UPGRADE_EVENT = 'velxio-pro-upgrade-prompt';

export function triggerProUpgradePrompt(
  featureName: string,
  detail?: Pick<BoardGateBlock, 'description' | 'requiredPlan' | 'cta'>,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(PRO_UPGRADE_EVENT, {
      detail: {
        componentName: featureName,
        featureName,
        ...(detail?.description ? { description: detail.description } : {}),
        ...(detail?.requiredPlan ? { requiredPlan: detail.requiredPlan } : {}),
        ...(detail?.cta ? { cta: detail.cta } : {}),
      },
    }),
  );
}

/**
 * The server refused to start a board (an `error` answer to start_pi /
 * start_stm32). The store already writes the message to the serial monitor
 * and stops the board; this tells whoever installed the gate, so an overlay
 * can refresh the state its verdict came from and prompt in place. The
 * event name is the contract; the OSS app dispatches and never listens.
 */
export const BOARD_RUN_REFUSED_EVENT = 'velxio-board-run-refused';

export interface BoardRunRefusedDetail {
  boardId: string;
  kind: string;
  message: string;
  /** Machine-readable reason when the server sent one (an overlay's own vocabulary). */
  code?: string;
}

export function reportBoardRunRefused(detail: BoardRunRefusedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BOARD_RUN_REFUSED_EVENT, { detail }));
}

/**
 * Human label for the upgrade prompt.
 *
 * An overlay board is named by its own label, not by the family whose run
 * path it borrows: `piFamily` routes the UNIHIKER M10 through the Raspberry
 * Pi bridge, and the prompt told its user that "Raspberry Pi emulation is a
 * Pro feature" about a board that is not a Raspberry Pi. The OSS families
 * keep their family names — every kind in them really is one.
 */
export function proBoardFeatureName(kind: BoardKind | string): string {
  const def = typeof kind === 'string' ? getProBoard(kind) : undefined;
  if (def) return `${def.label} emulation`;
  if (isStm32BoardKind(kind)) return 'STM32 emulation';
  if (isPiBoardKind(kind)) return 'Raspberry Pi emulation';
  return 'this board';
}
