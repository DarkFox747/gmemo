import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isEditableTarget, shortcutAction } from './shortcuts';
import type { ShortcutKey } from './shortcuts';

// Tests run in the node environment: stub the minimal DOM surface the guard reads.
class FakeElement {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
  ) {}
}

describe('isEditableTarget', () => {
  beforeEach(() => vi.stubGlobal('HTMLElement', FakeElement));
  afterEach(() => vi.unstubAllGlobals());

  it('is true for input, textarea, select and contenteditable', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isEditableTarget(new FakeElement(tag) as unknown as EventTarget)).toBe(true);
    }
    expect(isEditableTarget(new FakeElement('DIV', true) as unknown as EventTarget)).toBe(true);
  });

  it('is false for other elements and non-elements', () => {
    expect(isEditableTarget(new FakeElement('BUTTON') as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(new FakeElement('BODY') as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

const press = (key: string, extra: Partial<ShortcutKey> = {}): ShortcutKey => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  repeat: false,
  ...extra,
});

describe('shortcutAction', () => {
  it('A arms, then confirms when already armed', () => {
    expect(shortcutAction(press('a'), false)).toBe('arm');
    expect(shortcutAction(press('A'), true)).toBe('confirm');
  });

  it('Enter confirms only when armed', () => {
    expect(shortcutAction(press('Enter'), true)).toBe('confirm');
    expect(shortcutAction(press('Enter'), false)).toBe('ignore');
  });

  it('R only focuses the reason, never rejects', () => {
    expect(shortcutAction(press('r'), false)).toBe('focus-reason');
    expect(shortcutAction(press('r'), true)).toBe('focus-reason');
  });

  it('ignores modifiers, composition, repeat and other keys', () => {
    for (const extra of [
      { shiftKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { isComposing: true },
      { repeat: true },
    ]) {
      expect(shortcutAction(press('a', extra), false)).toBe('ignore');
      expect(shortcutAction(press('Enter', extra), true)).toBe('ignore');
    }
    expect(shortcutAction(press('x'), true)).toBe('ignore');
  });
});
