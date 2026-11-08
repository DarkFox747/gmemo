/** True when a key press targets a field where the user is typing (shortcuts must not fire). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** How long an armed approval waits for its confirmation. */
export const ARM_MS = 3000;

export interface ShortcutKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  repeat: boolean;
}

export type ShortcutAction = 'arm' | 'confirm' | 'focus-reason' | 'ignore';

/**
 * Review shortcuts: A arms the approval, A again or Enter confirms it, R only
 * focuses the rejection reason (rejecting stays a deliberate click).
 */
export function shortcutAction(e: ShortcutKey, armed: boolean): ShortcutAction {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) {
    return 'ignore';
  }
  const key = e.key.toLowerCase();
  if (key === 'a') return armed ? 'confirm' : 'arm';
  if (key === 'enter') return armed ? 'confirm' : 'ignore';
  if (key === 'r') return 'focus-reason';
  return 'ignore';
}
