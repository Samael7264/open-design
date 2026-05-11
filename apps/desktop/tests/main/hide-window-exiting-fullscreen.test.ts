// Issue #1215 — clicking the macOS red X while the preview is in fullscreen
// presentation mode hides the window but leaves the OS Space stuck as a
// black screen. The close handler is allowed to call window.hide(), but it
// must first arrange for the window to leave fullscreen so the Space tears
// down with the window.
//
// This spec exercises the contract through hideWindowExitingFullscreen with
// a structural mock — the bug shape is pure logic (sequence of calls), so
// no real Electron window is required.

import { describe, expect, test } from 'vitest';

import {
  hideWindowExitingFullscreen,
  type WindowFullscreenSurface,
} from '../../src/main/runtime.js';

type MockCalls = string[];

function createMockWindow(initial: {
  fullScreen?: boolean;
  simpleFullScreen?: boolean;
}): {
  window: WindowFullscreenSurface;
  calls: MockCalls;
  emitLeaveFullscreen: () => void;
} {
  const calls: MockCalls = [];
  let leaveListener: (() => void) | null = null;
  let fullScreen = initial.fullScreen ?? false;
  let simpleFullScreen = initial.simpleFullScreen ?? false;
  const window: WindowFullscreenSurface = {
    hide: () => calls.push('hide'),
    isFullScreen: () => fullScreen,
    isSimpleFullScreen: () => simpleFullScreen,
    setFullScreen: (flag) => {
      calls.push(`setFullScreen(${flag})`);
      fullScreen = flag;
    },
    setSimpleFullScreen: (flag) => {
      calls.push(`setSimpleFullScreen(${flag})`);
      simpleFullScreen = flag;
    },
    once: (event, listener) => {
      calls.push(`once(${event})`);
      if (event === 'leave-full-screen') leaveListener = listener;
      return undefined;
    },
  };
  return {
    calls,
    emitLeaveFullscreen: () => {
      const fn = leaveListener;
      leaveListener = null;
      fn?.();
    },
    window,
  };
}

describe('hideWindowExitingFullscreen', () => {
  test('hides directly when the window is not in fullscreen', () => {
    const { window, calls } = createMockWindow({});
    hideWindowExitingFullscreen(window);
    expect(calls).toEqual(['hide']);
  });

  test('exits native fullscreen first, defers hide until leave-full-screen fires', () => {
    const { window, calls, emitLeaveFullscreen } = createMockWindow({ fullScreen: true });
    hideWindowExitingFullscreen(window);

    // Before the OS confirms the Space has torn down, the window must NOT
    // be hidden — hiding mid-transition is what leaves the black Space.
    expect(calls).toEqual(['once(leave-full-screen)', 'setFullScreen(false)']);

    emitLeaveFullscreen();
    expect(calls).toEqual([
      'once(leave-full-screen)',
      'setFullScreen(false)',
      'hide',
    ]);
  });

  test('exits simpleFullScreen first, defers hide until leave-full-screen fires', () => {
    const { window, calls, emitLeaveFullscreen } = createMockWindow({ simpleFullScreen: true });
    hideWindowExitingFullscreen(window);

    expect(calls).toEqual(['once(leave-full-screen)', 'setSimpleFullScreen(false)']);

    emitLeaveFullscreen();
    expect(calls).toEqual([
      'once(leave-full-screen)',
      'setSimpleFullScreen(false)',
      'hide',
    ]);
  });
});
