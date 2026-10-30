import { setMouthLevel } from "../avatar/level";

/**
 * Plays synthesised WAV buffers and reports the audio envelope so the avatar
 * can move the jaw. One AudioContext per session; playback is exclusive.
 */
export interface Speaker {
  speak: (wav: ArrayBuffer) => Promise<void>;
  stop: () => void;
  setMuted: (muted: boolean) => void;
  isSpeaking: () => boolean;
}

export function createSpeaker(): Speaker {
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: AudioBufferSourceNode | null = null;
  let frame = 0;
  let muted = false;

  function ensureContext() {
    if (!context) {
      context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      analyser.connect(context.destination);
    }
    if (context.state === "suspended") void context.resume();
    return context;
  }

  function stop() {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (source) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
      source = null;
    }
    setMouthLevel(0);
  }

  async function speak(wav: ArrayBuffer) {
    if (muted) return;
    stop();
    const ctx = ensureContext();
    const buffer = await ctx.decodeAudioData(wav.slice(0));

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser!);
    src.onended = () => {
      console.info("[delamain] audio ended, peak level", peak.toFixed(2));
      if (source === src) {
        source = null;
        stop();
      }
    };

    source = src;
    src.start();
    console.info("[delamain] audio playing", buffer.duration.toFixed(2), "s");

    const data = new Uint8Array(analyser!.fftSize);
    let peak = 0;
    const tick = () => {
      analyser!.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, rms * 5.5);
      peak = Math.max(peak, level);
      setMouthLevel(level);
      frame = requestAnimationFrame(tick);
    };
    tick();
  }

  return {
    speak,
    stop,
    setMuted(value: boolean) {
      muted = value;
      if (muted) stop();
    },
    isSpeaking() {
      return source !== null;
    },
  };
}
