/**
 * One-off visual effects requested from outside the renderer (control socket,
 * boot sequence). The avatar subscribes; callers do not need a handle to it.
 */

let listener: (() => void) | null = null;

export function requestGlitch() {
  listener?.();
}

export function onGlitchRequest(callback: () => void) {
  listener = callback;
  return () => {
    if (listener === callback) listener = null;
  };
}
