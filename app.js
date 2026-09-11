import { SONG as INITIAL_SONG, CATALOG, SONG_ID as INITIAL_SONG_ID } from "./song-data.js?v=24";
import { createScoringController } from "./scoring-ui.js?v=24";
import { mixScoringGuide } from "./scoring.js?v=24";
let SONG = INITIAL_SONG;
let SONG_ID = INITIAL_SONG_ID;
let scoring = null;
let changingSong = false;
let accompanimentBuffer = null;

const $ = (id) => document.getElementById(id);
const els = {
  play: $("play-button"),
  playLabel: $("play-label"),
  seek: $("seek"),
  currentTime: $("current-time"),
  section: $("section-name"),
  kicker: $("lyric-kicker"),
  count: $("lyric-count"),
  viewport: $("lyric-viewport"),
  lines: $("lyric-lines"),
  waveform: $("waveform"),
  pitchCanvas: $("pitch-canvas"),
  vocal: $("vocal-mode"),
  key: $("key-select"),
  keyBadge: document.querySelector(".key-badge"),
  volume: $("volume"),
  hint: $("player-hint"),
  wasmStatus: $("wasm-status"),
  alignment: $("alignment-chip"),
  sectionNav: $("section-nav"),
  micButton: $("mic-button"),
  micStatus: $("mic-status"),
  micNote: $("mic-note"),
  micHz: $("mic-hz"),
  micMeter: $("mic-meter-fill"),
  micLevel: $("mic-level"),
  install: $("install-button"),
  update: $("update-button"),
  toast: $("toast"),
  audio: $("native-audio"),
  repeat: $("repeat-button"),
  repeatLabel: $("repeat-label"),
  screenState: $("screen-state"),
  modeButtons: [...document.querySelectorAll("[data-playback-mode]")],
  analysisToggle: $("analysis-toggle"),
  analysisOverlay: $("analysis-overlay"),
  menuButton: $("menu-button"),
  drawerTrigger: $("drawer-trigger"),
  drawerScrim: $("drawer-scrim"),
  drawer: $("control-drawer"),
  closeDrawer: $("close-drawer"),
};

let dsp = null;
let sourceBuffer = null;
let waveformData = [];
const processedBuffers = new Map();
let audioContext = null;
let activeSource = null;
let masterGain = null;
let audioOffset = 0;
let startedAt = 0;
let isPlaying = false;
let raf = 0;
let installPrompt = null;
let serviceWorkerRegistration = null;
let updateRequested = false;
let isRefreshing = false;
let toastTimer = 0;
let activeLineIndex = -1;
let lastLyricCaption = "";
let lyricRows = [];
const storedPlaybackMode = readSetting("ai-karaoke-playback-mode", "karaoke");
let playbackMode = ["karaoke", "player"].includes(storedPlaybackMode)
  ? storedPlaybackMode
  : "karaoke";
const repeatModes = ["repeat", "continuous", "single"];
const savedRepeatMode = readSetting("ai-karaoke-repeat-mode",
  readSetting("ai-karaoke-repeat", "false") === "true" ? "repeat" : "single");
let repeatMode = repeatModes.includes(savedRepeatMode) ? savedRepeatMode : "single";
let lastMediaSessionPositionUpdate = 0;

const VOCAL_AMOUNTS = { original: 0, light: 0.45, strong: 0.94 };
const WASM_INPUT_L = 0;
const WASM_INPUT_R = 131072;
const WASM_OUTPUT_L = 262144;
const WASM_OUTPUT_R = 393216;
const WASM_MIC = 524288;

function readSetting(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    /* storage is optional */
  }
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(value));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3600);
}

async function loadAlignment() {
  const song = SONG;
  const response = await fetch(`${SONG.alignmentSource}?v=24`);
  if (!response.ok) throw new Error(`ALIGNMENT ${response.status}`);
  const data = await response.json();
  if (song !== SONG) return;
  if (!Array.isArray(data.lines) || data.lines.length !== SONG.lines.length) {
    throw new Error("Alignment line count does not match the song data");
  }

  data.lines.forEach((aligned, index) => {
    const line = SONG.lines[index];
    if (line.text !== aligned.text)
      throw new Error(`Alignment text mismatch at line ${index + 1}`);
    line.start = aligned.start;
    line.end = aligned.end;
    line.tokens = aligned.tokens;
  });

  const visibleSections = SONG.sections.filter(
    (section) => section.lines.length > 0,
  );
  visibleSections.forEach((section) => {
    const sectionLines = SONG.lines.filter(
      (line) => line.sectionId === section.id,
    );
    if (sectionLines.length) {
      section.start = sectionLines[0].start;
      section.end = sectionLines[sectionLines.length - 1].end;
    }
  });
  SONG.sections.forEach((section, index) => {
    if (section.lines.length) return;
    const previous = [...visibleSections]
      .reverse()
      .find((item) => item.index < index);
    const next = visibleSections.find((item) => item.index > index);
    section.start = previous?.end ?? 0;
    section.end = next?.start ?? SONG.duration;
  });

  els.alignment.textContent = "文字タイムライン / 端末内解析";
  els.hint.textContent =
    playbackMode === "player"
      ? "プレイヤーモード · 歌詞を表示したままバックグラウンド再生"
      : "音源・歌詞・声はこの端末の中だけで処理されます。";
  renderPosition(audioOffset);
}

async function loadDsp() {
  try {
    const response = await fetch("./dsp.wasm");
    if (!response.ok) throw new Error(`WASM ${response.status}`);
    const result = await WebAssembly.instantiate(
      await response.arrayBuffer(),
      {},
    );
    dsp = result.instance.exports;
    els.wasmStatus.innerHTML =
      '<span class="status-dot"></span> WASM DSP READY';
  } catch (error) {
    els.wasmStatus.innerHTML =
      '<span class="status-dot" style="background:var(--orange)"></span> FALLBACK AUDIO';
    els.hint.textContent =
      "WASMの初期化に失敗しました。原音再生は引き続き利用できます。";
    console.error(error);
  }
}

function buildWaveformData(buffer) {
  const bins = 240;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const data = [];
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin / bins) * buffer.length);
    const end = Math.max(
      start + 1,
      Math.floor(((bin + 1) / bins) * buffer.length),
    );
    const stride = Math.max(1, Math.floor((end - start) / 180));
    let sum = 0;
    let count = 0;
    for (let offset = start; offset < end; offset += stride) {
      let sample = 0;
      for (const channel of channels) sample += channel[offset] || 0;
      sample /= channels.length;
      sum += sample * sample;
      count += 1;
    }
    data.push(Math.sqrt(sum / Math.max(1, count)));
  }
  const peak = Math.max(...data, 0.001);
  waveformData = data.map((value) => clamp(value / peak));
}

async function loadSourceBuffer() {
  if (sourceBuffer) return sourceBuffer;
  if (!audioContext)
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const response = await fetch(SONG.source);
  const bytes = await response.arrayBuffer();
  sourceBuffer = await audioContext.decodeAudioData(bytes);
  buildWaveformData(sourceBuffer);
  drawWaveform(audioOffset);
  return sourceBuffer;
}

function processBuffer(amount) {
  const cacheKey = amount.toFixed(2);
  if (processedBuffers.has(cacheKey)) return processedBuffers.get(cacheKey);
  if (!dsp || !sourceBuffer) return sourceBuffer;
  const output = audioContext.createBuffer(
    sourceBuffer.numberOfChannels,
    sourceBuffer.length,
    sourceBuffer.sampleRate,
  );
  const memory = new Float32Array(dsp.memory.buffer);
  const left = sourceBuffer.getChannelData(0);
  const right =
    sourceBuffer.numberOfChannels > 1 ? sourceBuffer.getChannelData(1) : left;
  const outLeft = output.getChannelData(0);
  const outRight =
    output.numberOfChannels > 1 ? output.getChannelData(1) : outLeft;
  const blockSize = 32768;
  dsp.reset_filter();
  for (let offset = 0; offset < sourceBuffer.length; offset += blockSize) {
    const length = Math.min(blockSize, sourceBuffer.length - offset);
    memory.set(left.subarray(offset, offset + length), WASM_INPUT_L / 4);
    memory.set(right.subarray(offset, offset + length), WASM_INPUT_R / 4);
    dsp.vocal_reduce(
      WASM_INPUT_L,
      WASM_INPUT_R,
      WASM_OUTPUT_L,
      WASM_OUTPUT_R,
      length,
      amount,
      sourceBuffer.sampleRate,
    );
    outLeft.set(
      memory.subarray(WASM_OUTPUT_L / 4, WASM_OUTPUT_L / 4 + length),
      offset,
    );
    if (output.numberOfChannels > 1)
      outRight.set(
        memory.subarray(WASM_OUTPUT_R / 4, WASM_OUTPUT_R / 4 + length),
        offset,
      );
  }
  processedBuffers.set(cacheKey, output);
  return output;
}

async function getActiveBuffer() {
  if (scoring?.locked) {
    if (!accompanimentBuffer) {
      const response = await fetch(SONG.accompanimentSource);
      if (!response.ok) throw new Error("Accompaniment unavailable");
      const backing = await audioContext.decodeAudioData(await response.arrayBuffer());
      const original = await loadSourceBuffer();
      // Both decoders use this AudioContext's sample rate. Keep each channel and
      // the timeline intact; tolerate codec padding differences at the tail.
      for (let channel = 0; channel < backing.numberOfChannels; channel++) {
        const target = backing.getChannelData(channel);
        const guide = original.getChannelData(Math.min(channel, original.numberOfChannels - 1));
        const length = Math.min(target.length, guide.length);
        mixScoringGuide(target.subarray(0, length), guide.subarray(0, length));
      }
      accompanimentBuffer = backing;
    }
    return accompanimentBuffer;
  }
  await loadSourceBuffer();
  const amount = VOCAL_AMOUNTS[els.vocal.value];
  if (amount === 0 || !dsp) return sourceBuffer;
  const cacheKey = amount.toFixed(2);
  if (!processedBuffers.has(cacheKey)) {
    els.hint.textContent =
      "WASMで中央定位のボーカルを処理中…少し待ってください。";
    await new Promise((resolve) => setTimeout(resolve, 20));
    const processed = processBuffer(amount);
    els.hint.textContent = "音源は端末内で処理されています。通信は不要です。";
    return processed;
  }
  return processedBuffers.get(cacheKey);
}

function currentPosition() {
  if (playbackMode === "player") {
    const position = Number(els.audio.currentTime);
    return Number.isFinite(position)
      ? clamp(position, 0, SONG.duration)
      : audioOffset;
  }
  if (!audioContext || !isPlaying) return audioOffset;
  const rate =
    activeSource?.playbackRate.value ?? 2 ** (Number(els.key.value) / 12);
  return Math.min(
    SONG.duration,
    audioOffset + (audioContext.currentTime - startedAt) * rate,
  );
}

function stopSource(resetPosition = false) {
  const position = resetPosition ? 0 : currentPosition();
  if (activeSource) {
    try {
      activeSource.stop();
    } catch (_) {
      /* already stopped */
    }
    activeSource.disconnect();
    activeSource = null;
  }
  if (els.audio && !els.audio.paused) els.audio.pause();
  if (resetPosition && els.audio) els.audio.currentTime = 0;
  audioOffset = position;
  isPlaying = false;
  cancelAnimationFrame(raf);
  els.play.classList.remove("playing");
  setPlayButtonState(false);
  updateMediaSessionState();
  renderPosition(audioOffset);
}

function setPlayButtonState(playing, loading = false) {
  els.play.classList.toggle("playing", playing);
  els.playLabel.textContent = loading
    ? "読み込み中"
    : playing
      ? "一時停止"
      : "再生";
  document.body.classList.toggle("is-playing", playing);
  els.play.setAttribute("aria-label", playing ? "一時停止" : "再生");
}

async function startPlayback() {
  if (playbackMode === "player") return startPlayerPlayback();
  if (!audioContext)
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") await audioContext.resume();
  const buffer = await getActiveBuffer();
  if (!masterGain) {
    masterGain = audioContext.createGain();
    masterGain.gain.value = Number(els.volume.value);
    masterGain.connect(audioContext.destination);
  }
  const playbackRate = 2 ** (Number(els.key.value) / 12);
  if (audioOffset >= buffer.duration - 0.05) audioOffset = 0;
  activeSource = audioContext.createBufferSource();
  activeSource.buffer = buffer;
  activeSource.playbackRate.value = playbackRate;
  activeSource.connect(masterGain);
  startedAt = audioContext.currentTime;
  activeSource.start(0, audioOffset);
  isPlaying = true;
  setPlayButtonState(true);
  updateMediaSessionState();
  renderLoop();
  const endedSource = activeSource;
  activeSource.onended = () => {
    if (!isPlaying || activeSource !== endedSource) return;
    if (scoring?.active) {
      finishPlayback();
      return;
    }
    if (repeatMode === "repeat") {
      activeSource = null;
      audioOffset = 0;
      void startPlayback();
      return;
    }
    void handleTrackEnd();
  };
}

async function startPlayerPlayback() {
  if (els.audio.ended || els.audio.currentTime >= SONG.duration - 0.05)
    els.audio.currentTime = 0;
  els.audio.loop = repeatMode === "repeat";
  els.audio.volume = Number(els.volume.value);
  els.audio.playbackRate = 2 ** (Number(els.key.value) / 12);
  await els.audio.play();
  isPlaying = true;
  audioOffset = els.audio.currentTime;
  setPlayButtonState(true);
  updateMediaSessionState();
  renderLoop();
}

function finishPlayback() {
  scoring?.finish(SONG.duration, true);
  if (els.audio) els.audio.pause();
  if (playbackMode === "player" && els.audio) els.audio.currentTime = 0;
  audioOffset = 0;
  isPlaying = false;
  activeSource = null;
  cancelAnimationFrame(raf);
  setPlayButtonState(false);
  updateMediaSessionState();
  renderPosition(0);
}

async function togglePlayback() {
  if (isPlaying) {
    stopSource();
    return;
  }
  els.play.disabled = true;
  setPlayButtonState(false, true);
  try {
    await startPlayback();
  } catch (error) {
    console.error(error);
    showToast("音源の読み込みに失敗しました。ページを再読み込みしてください。");
    setPlayButtonState(false);
  }
  els.play.disabled = false;
}

function charWeight(char) {
  if (/\s/.test(char)) return 0.35;
  if (/[、。！？「」『』]/.test(char)) return 0.45;
  return 1;
}

function setCharProgress(row, time, line) {
  const chars = row.querySelectorAll(".lyric-char");
  if (line.tokens?.length === chars.length) {
    chars.forEach((char, index) => {
      const token = line.tokens[index];
      const fill =
        clamp((time - token.start) / Math.max(0.01, token.end - token.start)) *
        100;
      char.style.setProperty("--fill", `${fill}%`);
      char.classList.toggle("filled", time >= token.end);
      char.classList.toggle("active", time >= token.start && time < token.end);
    });
    return;
  }
  const weights = [...chars].map((char) => charWeight(char.textContent));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const progress = clamp(
    (time - line.start) / Math.max(0.1, line.end - line.start),
  );
  let cursor = 0;
  chars.forEach((char, index) => {
    const start = cursor / total;
    const end = (cursor + weights[index]) / total;
    const fill = clamp((progress - start) / Math.max(0.001, end - start)) * 100;
    char.style.setProperty("--fill", `${fill}%`);
    char.classList.toggle("filled", progress >= end);
    char.classList.toggle("active", progress >= start && progress < end);
    cursor += weights[index];
  });
}

function makeLyricRows() {
  els.lines.replaceChildren();
  lyricRows = SONG.lines.map((line, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "lyric-line future";
    row.dataset.index = String(index);
    row.setAttribute("aria-label", `${index + 1}行目 ${line.text}`);
    row.addEventListener("click", () => {
      void jumpTo(line.start);
    });

    const number = document.createElement("span");
    number.className = "line-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const text = document.createElement("span");
    text.className = "line-text";
    for (const char of [...line.text]) {
      const charElement = document.createElement("span");
      charElement.className = "lyric-char";
      charElement.textContent = char;
      text.append(charElement);
    }
    row.append(number, text);
    els.lines.append(row);
    return row;
  });
}

function renderSectionNav() {
  els.sectionNav.replaceChildren();
  for (const section of SONG.sections.filter((item) => item.lines.length > 0)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "section-button";
    button.dataset.sectionId = section.id;
    button.innerHTML = `<small>${section.type}</small>${section.label}`;
    button.addEventListener("click", () => {
      setDrawerOpen(false);
      void jumpTo(section.start);
    });
    els.sectionNav.append(button);
  }
}

function updateLyricRows(time, lineIndex) {
  const nextIndex =
    lineIndex >= 0
      ? lineIndex + 1
      : SONG.lines.findIndex((line) => line.start > time);
  const followingIndex = lineIndex < 0 && nextIndex >= 0 ? nextIndex + 1 : -1;
  els.lines.classList.toggle("has-current", lineIndex >= 0);
  lyricRows.forEach((row, index) => {
    const line = SONG.lines[index];
    const progress = clamp(
      (time - line.start) / Math.max(0.1, line.end - line.start),
    );
    row.classList.toggle("current", index === lineIndex);
    row.classList.toggle("next-line", index === nextIndex);
    row.classList.toggle("following-line", index === followingIndex);
    row.classList.toggle(
      "past",
      index < lineIndex || (lineIndex < 0 && time >= line.end),
    );
    row.classList.toggle(
      "future",
      index > lineIndex && !(lineIndex < 0 && time >= line.end),
    );
    setCharProgress(row, time, line);
  });

  if (lineIndex !== activeLineIndex) {
    activeLineIndex = lineIndex;
  }
  const visibleKey = `${lineIndex}:${nextIndex}:${followingIndex}`;
  if (visibleKey !== fittedLyricKey) {
    fittedLyricKey = visibleKey;
    fitLyrics();
  }
}

function renderPosition(position) {
  const time = Math.min(SONG.duration, Math.max(0, position));
  els.seek.value = String(time);
  els.seek.style.setProperty("--progress", `${(time / SONG.duration) * 100}%`);
  document.body.classList.toggle("is-playing", isPlaying);
  els.screenState.textContent = scoring?.active
    ? isPlaying
      ? "採点中"
      : "採点一時停止"
    : isPlaying
      ? playbackMode === "player"
        ? "再生中"
        : "歌唱中"
      : time > 0
        ? "一時停止"
        : "スタンバイ";
  els.currentTime.textContent = formatTime(time);
  const lineIndex = SONG.lines.findIndex(
    (line) => time >= line.start && time < line.end,
  );
  const line = lineIndex >= 0 ? SONG.lines[lineIndex] : null;
  const next = SONG.lines.find((item) => item.start > time);
  const section =
    [...SONG.sections].reverse().find((item) => time >= item.start) ??
    SONG.sections[0];
  const captionLine = line ?? next;
  els.section.textContent = `${section.type} · ${section.label}`;
  if (captionLine)
    lastLyricCaption = `${captionLine.section} · ${captionLine.sectionLabel}`;
  const sectionNames = {
    VERSE: "Aメロ",
    "PRE-CHORUS": "Bメロ",
    CHORUS: "サビ",
    "FINAL CHORUS": "ラストサビ",
    BRIDGE: "Cメロ",
  };
  els.kicker.textContent = captionLine
    ? `${sectionNames[captionLine.section] || captionLine.section} · ${captionLine.sectionLabel}`
    : "アウトロ";
  const wait = next ? next.start - time : 0;
  // Judge the whole lyric gap so a long countdown keeps its final 2 → 1.
  const previousEnd = next ? Math.max(0, ...SONG.lines.filter((item) => item.start < next.start).map((item) => item.end)) : 0;
  const hasCountdownGap = next && next.start - previousEnd >= 3;
  $("countdown").hidden = !(isPlaying && !line && hasCountdownGap && wait > 0 && wait <= 4);
  $("countdown").textContent = String(Math.ceil(wait));
  $("lyric-guide").textContent = !isPlaying
    ? time > 0
      ? "続きから再生 · 歌詞をタップして移動"
      : "再生を押して、歌いはじめよう"
    : !line && next
      ? `歌い出しまで ${Math.ceil(wait)} 秒`
      : !line
        ? "余韻を、最後まで。"
        : "次の歌詞をタップして先へ";
  els.count.textContent = line
    ? `${String(lineIndex + 1).padStart(2, "0")} / ${SONG.lines.length}`
    : next
      ? `${String(SONG.lines.indexOf(next) + 1).padStart(2, "0")} / ${SONG.lines.length}`
      : `— / ${SONG.lines.length}`;
  document
    .querySelectorAll(".section-button")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.sectionId === section.id,
      ),
    );
  updateLyricRows(time, lineIndex);
  drawWaveform(time);
  scoring?.draw();
  updateMediaSessionPosition(time);
}

function drawWaveform(time = 0) {
  const canvas = els.waveform;
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 900;
  const height = 50;
  if (canvas.width !== width * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const data = waveformData.length
    ? waveformData
    : Array.from(
        { length: 240 },
        (_, index) =>
          0.28 +
          0.2 * Math.abs(Math.sin(index * 1.43)) +
          0.13 * Math.abs(Math.sin(index * 0.31 + 1)),
      );
  const progress = time / SONG.duration;
  const barWidth = width / data.length;
  data.forEach((value, index) => {
    const x = index * barWidth;
    const barHeight = Math.max(3, value * height * 0.82);
    ctx.fillStyle =
      index / data.length <= progress ? "#ff5b9e" : "rgba(255,245,238,.2)";
    ctx.fillRect(
      x,
      height / 2 - barHeight / 2,
      Math.max(1, barWidth - 1),
      barHeight,
    );
  });
  ctx.fillStyle = "#ffb16d";
  ctx.fillRect(progress * width - 1, 0, 2, height);
  ctx.fillStyle = "rgba(255,177,109,.7)";
  for (const line of SONG.lines) {
    const x = (line.start / SONG.duration) * width;
    ctx.fillRect(x, height - 3, 1, 3);
  }
}

function renderLoop() {
  renderPosition(currentPosition());
  if (isPlaying) raf = requestAnimationFrame(renderLoop);
}

async function jumpTo(time) {
  if (scoring?.locked) return;
  const wasPlaying = isPlaying;
  if (wasPlaying) stopSource();
  audioOffset = clamp(time, 0, SONG.duration);
  if (playbackMode === "player") els.audio.currentTime = audioOffset;
  renderPosition(audioOffset);
  if (!wasPlaying) return;
  els.play.disabled = true;
  setPlayButtonState(false, true);
  try {
    await startPlayback();
  } catch (error) {
    console.error("Playback resume after lyric seek failed", error);
    showToast("移動後の再生に失敗しました。もう一度お試しください。");
    setPlayButtonState(false);
  } finally {
    els.play.disabled = false;
  }
}

function seekFromControl(time) {
  const next = clamp(time, 0, SONG.duration);
  if (playbackMode === "player") {
    els.audio.currentTime = next;
    audioOffset = next;
    renderPosition(next);
    return;
  }
  void jumpTo(next);
}

function updateVolume() {
  const volume = Number(els.volume.value);
  if (masterGain) masterGain.gain.value = volume;
  if (els.audio) els.audio.volume = volume;
}

function updateRepeatUI() {
  const labels = { repeat: "1曲リピート", continuous: "連続再生", single: "1曲で停止" };
  els.audio.loop = repeatMode === "repeat";
  els.repeat.classList.toggle("active", repeatMode !== "single");
  els.repeat.removeAttribute("aria-pressed");
  els.repeatLabel.textContent = labels[repeatMode];
  const next = repeatModes[(repeatModes.indexOf(repeatMode) + 1) % repeatModes.length];
  els.repeat.title = `${labels[repeatMode]}（クリックで${labels[next]}）`;
  els.repeat.setAttribute("aria-label", els.repeat.title);
}

function toggleRepeat() {
  repeatMode = repeatModes[(repeatModes.indexOf(repeatMode) + 1) % repeatModes.length];
  saveSetting("ai-karaoke-repeat-mode", repeatMode);
  updateRepeatUI();
  showToast(`${els.repeatLabel.textContent}に切り替えました。`);
}

async function handleTrackEnd() {
  if (scoring?.active || repeatMode !== "continuous") {
    finishPlayback();
    return;
  }
  const index = CATALOG.songs.findIndex(song => song.id === SONG_ID);
  await changeSong(CATALOG.songs[(index + 1) % CATALOG.songs.length].id, true);
}

async function changeSong(id, autoplay = false) {
  if (changingSong || scoring?.locked) return;
  const entry = CATALOG.songs.find(song => song.id === id);
  if (!entry) return;
  changingSong = true;
  stopSource(true);
  els.play.disabled = true;
  document.getElementById("song-select").disabled = true;
  try {
    const response = await fetch(`${entry.data}?v=24`);
    if (!response.ok) throw new Error(`Song data: ${response.status}`);
    const song = await response.json();
    SONG = song;
    SONG_ID = id;
    sourceBuffer = null;
    accompanimentBuffer = null;
    processedBuffers.clear();
    waveformData = [];
    activeLineIndex = -1;
    lastLyricCaption = "";
    setupSong();
    scoring.setSong(id, SONG.melodySource);
    makeLyricRows();
    renderSectionNav();
    setupMediaSession();
    renderPosition(0);
    drawWaveform(0);
    const url = new URL(location.href);
    url.searchParams.set("song", id);
    history.replaceState(null, "", url.href);
    await loadAlignment().catch(console.error);
    if (autoplay) await startPlayback();
  } catch (error) {
    stopSource(true);
    showToast("再生を続けられませんでした。再生ボタンで再試行してください。");
    console.error(error);
  } finally {
    changingSong = false;
    els.play.disabled = false;
    document.getElementById("song-select").disabled = false;
    document.getElementById("song-select").value = SONG_ID;
  }
}

function updateModeUI() {
  const isPlayer = playbackMode === "player";
  document.body.classList.toggle("player-mode", isPlayer);
  els.modeButtons.forEach((button) => {
    const active = button.dataset.playbackMode === playbackMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  els.screenState.textContent = isPlayer ? "再生中" : "歌唱中";
  if (isPlayer && document.body.classList.contains("show-analysis"))
    setAnalysisVisible(false);
  els.hint.textContent = isPlayer
    ? "プレイヤーモード · 歌詞を表示したままバックグラウンド再生"
    : "音源・歌詞・声はこの端末の中だけで処理されます。";
  renderPosition(currentPosition());
}

async function setPlaybackMode(mode) {
  if (scoring?.locked) return;
  if (!["karaoke", "player"].includes(mode) || mode === playbackMode) return;
  const position = currentPosition();
  const wasPlaying = isPlaying;
  stopSource();
  playbackMode = mode;
  saveSetting("ai-karaoke-playback-mode", playbackMode);
  audioOffset = position;
  if (playbackMode === "player") {
    els.audio.currentTime = position;
    els.audio.loop = repeatMode === "repeat";
    els.audio.playbackRate = 2 ** (Number(els.key.value) / 12);
  }
  updateModeUI();
  if (wasPlaying) {
    els.play.disabled = true;
    setPlayButtonState(false, true);
    try {
      await startPlayback();
    } catch (error) {
      console.error(error);
      showToast("モード切替後の再生に失敗しました。");
      setPlayButtonState(false);
    }
    els.play.disabled = false;
  }
}

function seekRelative(offset) {
  const next = clamp(currentPosition() + offset, 0, SONG.duration);
  if (playbackMode === "player") {
    els.audio.currentTime = next;
    audioOffset = next;
    renderPosition(next);
    return;
  }
  jumpTo(next);
}

function updateMediaSessionState() {
  if ("mediaSession" in navigator)
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}

function updateMediaSessionPosition(time) {
  if (
    !("mediaSession" in navigator) ||
    typeof navigator.mediaSession.setPositionState !== "function" ||
    !isPlaying
  )
    return;
  const now = performance.now();
  if (now - lastMediaSessionPositionUpdate < 250) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: SONG.duration,
      playbackRate: Math.max(
        0.1,
        playbackMode === "player"
          ? els.audio.playbackRate
          : (activeSource?.playbackRate.value ?? 1),
      ),
      position: clamp(time, 0, SONG.duration),
    });
    lastMediaSessionPositionUpdate = now;
  } catch (_) {
    /* Media Session is optional */
  }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: SONG.title,
    artist: SONG.artist,
    album: SONG.artist,
    artwork: [{ src: SONG.cover, type: SONG.coverType }],
  });
  const handlers = {
    play: () => {
      if (!isPlaying) void togglePlayback();
    },
    pause: () => {
      if (isPlaying) stopSource();
    },
    seekbackward: (details) => seekRelative(-(details.seekOffset || 10)),
    seekforward: (details) => seekRelative(details.seekOffset || 10),
    previoustrack: () => seekRelative(-15),
    nexttrack: () => seekRelative(15),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (_) {
      /* unsupported action */
    }
  }
}

function setupNativeAudio() {
  els.audio.volume = Number(els.volume.value);
  els.audio.loop = repeatMode === "repeat";
  els.audio.addEventListener("play", () => {
    if (playbackMode !== "player") return;
    isPlaying = true;
    setPlayButtonState(true);
    updateMediaSessionState();
    renderLoop();
  });
  els.audio.addEventListener("pause", () => {
    if (playbackMode !== "player") return;
    audioOffset = Number.isFinite(els.audio.currentTime)
      ? els.audio.currentTime
      : audioOffset;
    if (!els.audio.ended) isPlaying = false;
    cancelAnimationFrame(raf);
    setPlayButtonState(false);
    updateMediaSessionState();
    renderPosition(audioOffset);
  });
  els.audio.addEventListener("timeupdate", () => {
    if (playbackMode === "player") renderPosition(els.audio.currentTime);
  });
  els.audio.addEventListener("ended", () => {
    if (playbackMode === "player" && repeatMode !== "repeat") void handleTrackEnd();
  });
  els.audio.addEventListener("error", () =>
    showToast("音源を読み込めませんでした。ページを再読み込みしてください。"),
  );
}

async function changeVocalMode() {
  if (playbackMode === "player") {
    showToast("ボーカル設定はカラオケモードで使用できます。");
    return;
  }
  updateVocalToggle();
  if (!isPlaying) {
    els.hint.textContent = "次の再生からボーカル設定を適用します。";
    return;
  }
  const position = currentPosition();
  stopSource();
  audioOffset = position;
  await startPlayback();
}

async function changeKey() {
  const value = Number(els.key.value);
  els.keyBadge.textContent = `KEY ${value === 0 ? "±0" : value > 0 ? `+${value}` : value}`;
  if (playbackMode === "player") {
    els.audio.playbackRate = 2 ** (value / 12);
    renderPosition(currentPosition());
    return;
  }
  if (!isPlaying) return;
  const position = currentPosition();
  stopSource();
  audioOffset = position;
  await startPlayback();
}

function noteName(frequency) {
  if (!frequency) return "--";
  const names = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  return `${names[(midi + 120) % 12]}${Math.floor(midi / 12) - 1}`;
}

function drawPitchHistory() {
  scoring?.draw();
}
async function toggleMic() {
  await scoring.toggle();
}

function setAnalysisVisible(visible) {
  document.body.classList.toggle("show-analysis", visible);
  els.analysisOverlay.setAttribute("aria-hidden", String(!visible));
  els.analysisToggle.setAttribute("aria-expanded", String(visible));
  els.analysisToggle.textContent = visible ? "ジャケット表示" : "採点・音程";
  els.analysisOverlay.inert = !visible;
  requestAnimationFrame(fitLyrics);
  if (visible) drawPitchHistory();
}

let sheetReturnFocus = null;
function setDrawerOpen(open) {
  if (open) sheetReturnFocus = document.activeElement;
  document.body.classList.toggle("drawer-open", open);
  els.drawerScrim.hidden = !open;
  els.drawer.setAttribute("aria-hidden", String(!open));
  els.drawer.inert = !open;
  document.querySelector(".karaoke-app").inert = open;
  els.menuButton.setAttribute("aria-expanded", String(open));
  els.drawerTrigger.setAttribute("aria-expanded", String(open));
  if (open) els.closeDrawer.focus();
  else if (sheetReturnFocus) {
    sheetReturnFocus.focus();
    sheetReturnFocus = null;
  }
}
function selectSheetTab(name) {
  document.querySelectorAll("[data-sheet-tab]").forEach((button) => {
    const active = button.dataset.sheetTab === name;
    button.setAttribute("aria-selected", String(active));
    $(button.dataset.sheetTab + "-panel").hidden = !active;
  });
}
let fittedLyricKey = "";
function fitLyrics() {
  const rows = lyricRows.filter((row) =>
    row.matches(".current,.next-line,.following-line"),
  );
  const available = els.lines.clientWidth - 4;
  if (available <= 0) return;
  const base = Math.min(36, Math.max(23, available / 13));
  els.lines.style.setProperty("--lyric-size", `${base}px`);
  const widest = Math.max(
    ...rows.map(
      (row) => row.querySelector(".line-text").getBoundingClientRect().width,
    ),
    1,
  );
  if (widest > available)
    els.lines.style.setProperty(
      "--lyric-size",
      `${(base * available) / widest}px`,
    );
}
function updateVocalToggle() {
  const reduced = els.vocal.value !== "original";
  $("vocal-toggle").setAttribute("aria-pressed", String(reduced));
  $("vocal-toggle").textContent = reduced ? "伴奏優先" : "原曲ボーカル";
}
function syncViewport() {
  // visualViewport excludes mobile browser chrome and the software keyboard.
  document.documentElement.style.setProperty(
    "--app-height",
    `${window.visualViewport?.height || window.innerHeight}px`,
  );
  requestAnimationFrame(() => {
    fitLyrics();
    drawPitchHistory();
  });
}

function showUpdateAvailable() {
  if (!els.update.hidden) return;
  els.update.hidden = false;
  showToast("新しいバージョンがあります。設定 → アプリから更新できます。");
}

function applyWaitingWorker(registration) {
  if (scoring?.locked) {
    showToast("採点を終了してから更新してください。");
    return true;
  }
  const waiting = registration?.waiting;
  if (!waiting) return false;
  updateRequested = true;
  els.update.hidden = false;
  els.update.disabled = true;
  els.update.textContent = "更新中…";
  waiting.postMessage({ type: "SKIP_WAITING" });
  return true;
}

function handleInstalledWorker(registration) {
  if (!navigator.serviceWorker.controller) return;
  if (isPlaying || scoring?.locked) showUpdateAvailable();
  else applyWaitingWorker(registration);
}

function watchInstallingWorker(registration) {
  const worker = registration.installing;
  if (!worker) return;
  worker.addEventListener("statechange", () => {
    if (worker.state === "installed") handleInstalledWorker(registration);
  });
}

async function checkForServiceWorkerUpdate() {
  try {
    await serviceWorkerRegistration?.update();
    if (serviceWorkerRegistration?.waiting)
      handleInstalledWorker(serviceWorkerRegistration);
  } catch (error) {
    console.debug("Service Worker update check failed", error);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (isRefreshing || !hadController) return;
    if (!scoring?.locked && (updateRequested || !isPlaying)) {
      isRefreshing = true;
      window.location.reload();
      return;
    }
    showUpdateAvailable();
  });
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register(
      "./sw.js",
      { updateViaCache: "none" },
    );
    serviceWorkerRegistration.addEventListener("updatefound", () =>
      watchInstallingWorker(serviceWorkerRegistration),
    );
    if (serviceWorkerRegistration.waiting)
      handleInstalledWorker(serviceWorkerRegistration);
    await checkForServiceWorkerUpdate();
  } catch (error) {
    console.error("Service Worker registration failed", error);
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  els.install.hidden = false;
});
els.install.addEventListener("click", async () => {
  if (!installPrompt) {
    showToast("ブラウザの共有メニューから「ホーム画面に追加」を選べます。");
    return;
  }
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  els.install.hidden = true;
});
els.play.addEventListener("click", togglePlayback);
els.repeat.addEventListener("click", toggleRepeat);
els.modeButtons.forEach((button) =>
  button.addEventListener("click", () => {
    void setPlaybackMode(button.dataset.playbackMode);
  }),
);
els.seek.addEventListener("input", () =>
  seekFromControl(Number(els.seek.value)),
);
els.volume.addEventListener("input", updateVolume);
els.vocal.addEventListener("change", changeVocalMode);
els.key.addEventListener("change", changeKey);
els.micButton.addEventListener("click", toggleMic);
els.analysisToggle.addEventListener("click", () =>
  setAnalysisVisible(!document.body.classList.contains("show-analysis")),
);
els.menuButton.addEventListener("click", () => {
  selectSheetTab("sound");
  setDrawerOpen(true);
});
els.drawerTrigger.addEventListener("click", () => {
  selectSheetTab("lyrics");
  setDrawerOpen(true);
});
els.closeDrawer.addEventListener("click", () => setDrawerOpen(false));
els.drawerScrim.addEventListener("click", () => setDrawerOpen(false));
els.update.addEventListener("click", () => {
  if (!applyWaitingWorker(serviceWorkerRegistration)) {
    updateRequested = true;
    window.location.reload();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setDrawerOpen(false);
    setAnalysisVisible(false);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForServiceWorkerUpdate();
});
window.addEventListener("focus", checkForServiceWorkerUpdate);
window.addEventListener("resize", () => {
  drawWaveform(audioOffset);
  drawPitchHistory();
});

function setupSong() {
  document.title = `${SONG.title} / KARAOKE`;
  document.querySelector('meta[name="description"]').content = `${SONG.title} — ${SONG.artist} / KARAOKE`;
  const select = document.getElementById('song-select');
  select.replaceChildren();
  for (const song of CATALOG.songs) {
    const option = document.createElement('option');
    option.value = song.id;
    option.textContent = song.title;
    option.selected = song.id === SONG_ID;
    select.append(option);
  }
  select.onchange = () => {
    void changeSong(select.value, isPlaying && repeatMode === "continuous");
  };
  document.querySelector('.brand-copy small').textContent = SONG.artist;
  document.querySelector('.art-title').textContent = SONG.title;
  document.querySelector('.result-header small').textContent = `${SONG.title} / ${SONG.artist}`;
  document.querySelector('.art-eyebrow').textContent = SONG.artist;
  const art = document.querySelector('.cover-art');
  art.src = SONG.cover;
  art.alt = `${SONG.title} ジャケット`;
  document.querySelector('.drawer-head h2').textContent = SONG.title;
  document.querySelector('.drawer-head h2 + p').textContent = `歌手 ${SONG.artist}`;
  els.audio.src = SONG.source;
  els.seek.max = SONG.duration;
  document.querySelector('#current-time + span').textContent = formatTime(SONG.duration);
}
setupSong();

scoring = createScoringController({
  songId: SONG_ID,
  lineCount: SONG.lines.length,
  referenceUrl: SONG.melodySource,
  position: currentPosition,
  playing: () => isPlaying,
  key: () => Number(els.key.value),
  pause: stopSource,
  beforeResults: () => setDrawerOpen(false),
  toast: showToast,
  show: () => setAnalysisVisible(true),
  lineText: (index) => SONG.lines[index]?.text ?? `${index + 1}行目`,
  inLyrics: (time) =>
    SONG.lines.some((line) => time >= line.start && time < line.end),
  restart: async () => {
    stopSource(true);
    audioOffset = 0;
    await startPlayback();
  },
});
setupNativeAudio();
updateRepeatUI();
updateModeUI();
setupMediaSession();
document
  .querySelectorAll("[data-sheet-tab]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      selectSheetTab(button.dataset.sheetTab),
    ),
  );
$("vocal-toggle").addEventListener("click", () => {
  els.vocal.value = els.vocal.value === "original" ? "light" : "original";
  void changeVocalMode().catch(() =>
    showToast("音源を切り替えられませんでした。"),
  );
});
$("previous-phrase").addEventListener("click", () => {
  const time = currentPosition();
  const line = [...SONG.lines].reverse().find((line) => line.start < time - 1);
  void jumpTo(line?.start ?? 0);
});
$("next-phrase").addEventListener("click", () => {
  const line = SONG.lines.find((line) => line.start > currentPosition() + 0.2);
  if (line) void jumpTo(line.start);
});
$("fullscreen-button").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen)
      await document.documentElement.requestFullscreen();
    else showToast("ホーム画面に追加すると全画面で楽しめます。");
  } catch {
    showToast("この環境では全画面に切り替えられません。");
  }
});
document.addEventListener("fullscreenchange", () => {
  $("fullscreen-button").setAttribute(
    "aria-label",
    document.fullscreenElement ? "全画面を解除" : "全画面にする",
  );
  syncViewport();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !document.body.classList.contains("drawer-open"))
    return;
  const controls = [
    ...els.drawer.querySelectorAll("button,select,input"),
  ].filter((el) => el.getClientRects().length && !el.disabled);
  const first = controls[0],
    last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
window.visualViewport?.addEventListener("resize", syncViewport);
window.addEventListener("resize", syncViewport);
new ResizeObserver(fitLyrics).observe(els.viewport);
updateVocalToggle();
syncViewport();
makeLyricRows();
renderSectionNav();
registerServiceWorker();
window.setInterval(checkForServiceWorkerUpdate, 15 * 60 * 1000);
loadDsp();
loadAlignment().catch((error) => {
  els.alignment.textContent = "GRID FALLBACK / ALIGNMENT ERROR";
  els.hint.textContent =
    "文字タイムラインの読み込みに失敗しました。行単位の予備データで再生します。";
  console.error(error);
});
renderPosition(0);
drawWaveform(0);
drawPitchHistory();
changeKey();
