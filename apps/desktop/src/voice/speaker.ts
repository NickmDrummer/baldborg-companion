import { setMouthLevel } from "../avatar/level";

export type EffectsPreset = "clean" | "device" | "radio" | "hologram";

/**
 * Plays synthesised WAV buffers and reports the audio envelope so the avatar
 * can move the jaw. One AudioContext per session; playback is exclusive.
 *
 * The effects chain lives between the source and the analyser, so the jaw
 * follows the processed sound. Presets only change node parameters; the graph
 * is built once.
 */
export interface Speaker {
  speak: (wav: ArrayBuffer) => Promise<void>;
  stop: () => void;
  setMuted: (muted: boolean) => void;
  setEffects: (preset: EffectsPreset) => void;
  isSpeaking: () => boolean;
}

interface Preset {
  drive: number;
  highpass: number;
  lowpass: number;
  bits: number;
  echo: number;
  feedback: number;
  level: number;
}

const PRESETS: Record<EffectsPreset, Preset> = {
  clean: {
    drive: 0,
    highpass: 20,
    lowpass: 20_000,
    bits: 16,
    echo: 0,
    feedback: 0,
    level: 1,
  },
  device: {
    drive: 2.6,
    highpass: 240,
    lowpass: 4_800,
    bits: 9,
    echo: 0.1,
    feedback: 0.12,
    level: 0.9,
  },
  radio: {
    drive: 4.5,
    highpass: 380,
    lowpass: 3_000,
    bits: 7,
    echo: 0.06,
    feedback: 0.08,
    level: 0.85,
  },
  hologram: {
    drive: 3,
    highpass: 180,
    lowpass: 6_000,
    bits: 8,
    echo: 0.22,
    feedback: 0.18,
    level: 0.9,
  },
};

function driveCurve(amount: number) {
  if (amount <= 0) return null;
  const size = 2048;
  const curve = new Float32Array(size);
  const normal = Math.tanh(amount);
  for (let index = 0; index < size; index += 1) {
    const x = (index / (size - 1)) * 2 - 1;
    curve[index] = Math.tanh(x * amount) / normal;
  }
  return curve;
}

function crushCurve(bits: number) {
  if (bits >= 16) return null;
  const size = 4096;
  const steps = 2 ** bits;
  const curve = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const x = (index / (size - 1)) * 2 - 1;
    curve[index] = Math.round(x * steps) / steps;
  }
  return curve;
}

export function createSpeaker(preset: EffectsPreset = "device"): Speaker {
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: AudioBufferSourceNode | null = null;
  let frame = 0;
  let muted = false;
  let currentPreset: EffectsPreset = preset;

  let input: GainNode | null = null;
  let drive: WaveShaperNode | null = null;
  let highpass: BiquadFilterNode | null = null;
  let lowpass: BiquadFilterNode | null = null;
  let crush: WaveShaperNode | null = null;
  let delay: DelayNode | null = null;
  let feedback: GainNode | null = null;
  let wet: GainNode | null = null;
  let compressor: DynamicsCompressorNode | null = null;

  function applyPreset() {
    if (!input || !drive || !highpass || !lowpass || !crush || !delay || !wet || !feedback) {
      return;
    }
    const settings = PRESETS[currentPreset] ?? PRESETS.device;
    input.gain.value = settings.level;
    drive.curve = driveCurve(settings.drive);
    drive.oversample = "2x";
    highpass.frequency.value = settings.highpass;
    lowpass.frequency.value = settings.lowpass;
    crush.curve = crushCurve(settings.bits);
    delay.delayTime.value = 0.018;
    wet.gain.value = settings.echo;
    feedback.gain.value = settings.feedback;
    if (compressor) {
      compressor.threshold.value = currentPreset === "clean" ? 0 : -14;
      compressor.ratio.value = currentPreset === "clean" ? 1 : 4;
    }
  }

  function ensureContext() {
    if (!context) {
      context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;

      input = context.createGain();
      drive = context.createWaveShaper();
      highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      crush = context.createWaveShaper();
      delay = context.createDelay(0.1);
      feedback = context.createGain();
      wet = context.createGain();
      compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.ratio.value = 4;

      input.connect(drive);
      drive.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(crush);
      crush.connect(analyser);
      crush.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(analyser);
      analyser.connect(compressor);
      compressor.connect(context.destination);

      applyPreset();
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
    src.connect(input!);
    src.onended = () => {
      console.info("[baldborg] audio ended, peak level", peak.toFixed(2));
      if (source === src) {
        source = null;
        stop();
      }
    };

    source = src;
    src.start();
    console.info("[baldborg] audio playing", buffer.duration.toFixed(2), "s");

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
      const level = Math.min(1, rms * 12);
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
    setEffects(value: EffectsPreset) {
      currentPreset = PRESETS[value] ? value : "device";
      applyPreset();
    },
    isSpeaking() {
      return source !== null;
    },
  };
}
