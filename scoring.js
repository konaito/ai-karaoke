// Local practice scoring. No random bonuses or imitation of commercial scoring.
export const SCORING_VERSION = "pitch-v1";
export const frequencyToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToFrequency = (midi) => 440 * 2 ** ((midi - 69) / 12);
export function pitchCredit(cents) {
  const error = Math.abs(cents);
  return error <= 25 ? 1 : Math.max(0, 1 - (error - 25) / 175);
}
export function pitchError(actual, target, octave = true) {
  let delta = actual - target;
  if (octave) delta -= Math.round(delta / 12) * 12;
  return delta * 100;
}

// YIN cumulative mean normalized difference, with first-trough selection and
// parabolic refinement. Downsample first to keep mobile CPU work bounded.
export class PitchDetector {
  constructor() {
    this.samples = new Float32Array(2048);
    this.diff = new Float32Array(512);
  }
  detect(input, sampleRate) {
    const stride = Math.max(1, Math.floor(sampleRate / 12000));
    const rate = sampleRate / stride;
    const length = Math.min(
      this.samples.length,
      Math.floor(input.length / stride),
    );
    let mean = 0,
      energy = 0;
    for (let i = 0; i < length; i++) {
      let value = 0;
      for (let j = 0; j < stride; j++) value += input[i * stride + j];
      value /= stride;
      this.samples[i] = value;
      mean += value;
      energy += value * value;
    }
    const rms = Math.sqrt(energy / Math.max(1, length));
    if (rms < 0.008 || length < 256) return { hz: 0, rms, confidence: 0 };
    mean /= length;
    for (let i = 0; i < length; i++) this.samples[i] -= mean;
    const minLag = Math.max(2, Math.floor(rate / 900));
    const maxLag = Math.min(
      this.diff.length - 2,
      Math.floor(rate / 65),
      Math.floor(length / 2),
    );
    const window = length - maxLag;
    let cumulative = 0;
    this.diff[0] = 1;
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < window; i++) {
        const delta = this.samples[i] - this.samples[i + lag];
        sum += delta * delta;
      }
      cumulative += sum;
      this.diff[lag] = cumulative > 1e-12 ? (sum * lag) / cumulative : 1;
    }
    let lag = minLag;
    while (lag < maxLag) {
      if (this.diff[lag] < 0.15) {
        while (lag + 1 <= maxLag && this.diff[lag + 1] < this.diff[lag]) lag++;
        const confidence = 1 - this.diff[lag];
        const left = this.diff[lag - 1],
          middle = this.diff[lag],
          right = this.diff[Math.min(maxLag, lag + 1)];
        const denominator = left - 2 * middle + right;
        const refined =
          lag +
          (Math.abs(denominator) > 1e-10
            ? (0.5 * (left - right)) / denominator
            : 0);
        return { hz: rate / refined, rms, confidence };
      }
      lag++;
    }
    return { hz: 0, rms, confidence: 0 };
  }
}

export function validateReference(data) {
  if (
    data?.version !== 1 ||
    !Number.isFinite(data.step) ||
    data.step < 0.02 ||
    data.step > 0.1 ||
    !Array.isArray(data.frames) ||
    !data.frames.length
  )
    throw new Error("Invalid melody reference");
  let previous = -1;
  for (const frame of data.frames) {
    if (
      !Array.isArray(frame) ||
      frame.length !== 4 ||
      !frame.every(Number.isFinite) ||
      frame[0] < 0 ||
      frame[0] <= previous ||
      Math.abs(frame[0] / data.step - Math.round(frame[0] / data.step)) >
        0.001 ||
      frame[1] < 30 ||
      frame[1] > 100 ||
      frame[2] < 0.6 ||
      frame[2] > 1 ||
      !Number.isInteger(frame[3]) ||
      frame[3] < 0
    )
      throw new Error("Invalid melody frame");
    previous = frame[0];
  }
  return data;
}

export class ScoreSession {
  constructor(reference, { key = 0, octave = true } = {}) {
    this.reference = validateReference(reference);
    this.key = key;
    this.octave = octave;
    this.bins = new Map(
      reference.frames.map((frame, index) => [
        Math.round(frame[0] / reference.step),
        index,
      ]),
    );
    this.samples = new Map();
  }
  targetAt(time) {
    const index = this.bins.get(Math.round(time / this.reference.step));
    return index === undefined
      ? null
      : {
          index,
          time: this.reference.frames[index][0],
          midi: this.reference.frames[index][1] + this.key,
          line: this.reference.frames[index][3],
        };
  }
  add(time, hz, confidence = 1) {
    const target = this.targetAt(time);
    if (!target || !Number.isFinite(hz) || hz <= 0 || confidence < 0.8)
      return null;
    const error = pitchError(frequencyToMidi(hz), target.midi, this.octave);
    const existing = this.samples.get(target.index) ?? {
      total: 0,
      count: 0,
      error: 0,
    };
    existing.total += pitchCredit(error);
    existing.error += error;
    existing.count++;
    this.samples.set(target.index, existing);
    return { ...target, error, credit: pitchCredit(error) };
  }
  result(until = Infinity) {
    let expected = 0,
      voiced = 0,
      earned = 0,
      matched = 0;
    const lines = new Map();
    for (let i = 0; i < this.reference.frames.length; i++) {
      const [time, , , line] = this.reference.frames[i];
      if (time > until) break;
      expected++;
      const row = lines.get(line) ?? {
        line,
        expected: 0,
        voiced: 0,
        earned: 0,
      };
      row.expected++;
      const sample = this.samples.get(i);
      if (sample) {
        const credit = sample.total / sample.count;
        voiced++;
        earned += credit;
        row.voiced++;
        row.earned += credit;
        if (credit >= 1 - 25 / 175) matched++;
      }
      lines.set(line, row);
    }
    const enough =
      voiced * this.reference.step >= 3 && expected * this.reference.step >= 5;
    return {
      version: SCORING_VERSION,
      referenceVersion: this.reference.sourceSha256,
      key: this.key,
      enough,
      score: enough
        ? Math.round((1000 * earned) / Math.max(1, expected)) / 10
        : null,
      accuracy: voiced ? Math.round((100 * matched) / voiced) : null,
      coverage: expected ? Math.round((100 * voiced) / expected) : 0,
      expectedSeconds: expected * this.reference.step,
      voicedSeconds: voiced * this.reference.step,
      lines: [...lines.values()].map((row) => ({
        line: row.line,
        sufficient: row.expected * this.reference.step >= 0.3,
        coverage: Math.round((100 * row.voiced) / row.expected),
        score:
          row.voiced && row.expected * this.reference.step >= 0.3
            ? Math.round((100 * row.earned) / row.expected)
            : null,
      })),
    };
  }
}
