/**
 * One-off visual effects requested from outside the renderer (control socket,
 * boot sequence). The avatar subscribes; callers do not need a handle to it.
 */

let listener: (() => void) | null = null;
let calmListener: ((ms: number) => void) | null = null;

export function requestGlitch() {
  listener?.();
}

/** Keep automatic glitch bursts quiet for a short layout transition. */
export function requestCalm(ms = 700) {
  calmListener?.(ms);
}

export function onGlitchRequest(callback: () => void) {
  listener = callback;
  return () => {
    if (listener === callback) listener = null;
  };
}

export function onCalmRequest(callback: (ms: number) => void) {
  calmListener = callback;
  return () => {
    if (calmListener === callback) calmListener = null;
  };
}
