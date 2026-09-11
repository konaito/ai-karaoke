import test from "node:test";
import assert from "node:assert/strict";
import {
  PitchDetector,
  ScoreSession,
  midiToFrequency,
  validateReference,
} from "../scoring.js";
const reference = {
  version: 1,
  step: 0.05,
  sourceSha256: "fixture",
  frames: Array.from({ length: 200 }, (_, i) => [
    i * 0.05,
    60 + (i > 99 ? 2 : 0),
    0.95,
    i > 99 ? 1 : 0,
  ]),
};
function sing(offset = 0, coverage = 1, frequency = 1) {
  const session = new ScoreSession(reference);
  for (const [time, midi] of reference.frames.slice(
    0,
    Math.floor(200 * coverage),
  ))
    for (let i = 0; i < frequency; i++)
      session.add(time, midiToFrequency(midi + offset));
  return session.result();
}
test("on-pitch singing receives full credit; silence is unscorable", () => {
  assert.equal(sing().score, 100);
  assert.equal(new ScoreSession(reference).result().score, null);
});
test("wrong notes lose credit and silent sections reduce total score", () => {
  assert.equal(sing(3).score, 0);
  assert.equal(sing(0, 0.5).score, 50);
  assert.equal(sing(0, 0.5).coverage, 50);
});
test("octave singing accepted, transposition compared against selected key", () => {
  assert.equal(sing(-12).score, 100);
  const s = new ScoreSession(reference, { key: 3 });
  for (const [t, m] of reference.frames) s.add(t, midiToFrequency(m + 3));
  assert.equal(s.result().score, 100);
});
test("repeated samples and pauses do not inflate available points", () =>
  assert.deepEqual(sing(0.5, 1, 1), sing(0.5, 1, 4)));
test("low confidence and nonfinite pitches receive no credit", () => {
  const s = new ScoreSession(reference);
  for (const [t, m] of reference.frames) {
    s.add(t, midiToFrequency(m), 0.1);
    s.add(t, Infinity);
    s.add(t, NaN);
  }
  assert.equal(s.result().score, null);
});
test("future phrases are excluded from partial result and seek gaps remain unvoiced", () => {
  const s = new ScoreSession(reference);
  for (const [t, m] of reference.frames.slice(100))
    s.add(t, midiToFrequency(m));
  assert.equal(s.result().score, 50);
  assert.equal(s.result(4).voicedSeconds, 0);
});
test("malformed reference cannot silently score", () =>
  assert.throws(() =>
    validateReference({
      ...reference,
      frames: [
        [0, 60, 0.95, 0],
        [0, 62, 0.95, 1],
      ],
    }),
  ));
for (const rate of [44100, 48000])
  for (const hz of [82.41, 130.81, 220, 440, 659.25])
    test(`YIN detects ${hz}Hz at ${rate}Hz with harmonics`, () => {
      const x = Float32Array.from(
        { length: 4096 },
        (_, i) =>
          0.15 * Math.sin((2 * Math.PI * hz * i) / rate) +
          0.1 * Math.sin((4 * Math.PI * hz * i) / rate) +
          0.03,
      );
      const d = new PitchDetector().detect(x, rate);
      assert.ok(Math.abs(1200 * Math.log2(d.hz / hz)) < 15, JSON.stringify(d));
    });
test("silence and deterministic white noise do not produce pitch", () => {
  const d = new PitchDetector();
  assert.equal(d.detect(new Float32Array(4096), 48000).hz, 0);
  let seed = 1;
  const x = Float32Array.from({ length: 4096 }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.2;
  });
  assert.equal(d.detect(x, 48000).hz, 0);
});

test("bundled reference matches the source audio and covers every lyric line", async () => {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const data = validateReference(
    JSON.parse(await fs.readFile(new URL("../melody.json", import.meta.url))),
  );
  const audio = await fs.readFile(
    new URL("../audio/track.mp3", import.meta.url),
  );
  assert.equal(
    data.sourceSha256,
    createHash("sha256").update(audio).digest("hex"),
  );
  const alignment = JSON.parse(
    await fs.readFile(new URL("../alignment.json", import.meta.url)),
  );
  assert.equal(
    new Set(data.frames.map((f) => f[3])).size,
    alignment.lines.length,
  );
  for (const [t, , , line] of data.frames) {
    assert.ok(
      t >= alignment.lines[line].start && t <= alignment.lines[line].end,
    );
  }
});
test("tiny reference fragments are not presented as meaningful phrase scores", () => {
  const s = new ScoreSession({
    ...reference,
    frames: reference.frames.slice(0, 2),
  });
  s.add(0, midiToFrequency(60));
  assert.equal(s.result().lines[0].score, null);
});

test('scoring guide retains vocals without doubling the shared accompaniment', async () => {
  const {mixScoringGuide} = await import('../scoring.js');
  const original = new Float32Array([0.6, -0.6, 0.4, -0.4]);
  const backing = new Float32Array([0.2, -0.2, 0.4, -0.4]);
  const mixed = mixScoringGuide(backing, original);
  assert.ok(Math.abs(mixed[0] - 0.4) < 1e-6);
  assert.ok(Math.abs(mixed[1] + 0.4) < 1e-6);
  assert.ok(Math.abs(mixed[2] - 0.4) < 1e-6);
  assert.ok(Math.abs(original[0] - 0.6) < 1e-6);
});
