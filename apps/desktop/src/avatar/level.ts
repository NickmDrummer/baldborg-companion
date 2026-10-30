/**
 * Shared mouth level between the audio analyser and the avatar rig.
 * A plain module avoids re-rendering React at 60 fps just to animate a jaw.
 */

type Listener = (level: number) => void;

let listener: Listener | null = null;

export function setMouthLevel(level: number) {
  listener?.(level);
}

export function onMouthLevel(callback: Listener) {
  listener = callback;
  return () => {
    if (listener === callback) listener = null;
  };
}
