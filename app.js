import { SONG } from "./song-data.js";

const $ = (id) => document.getElementById(id);
const els = {
  play: $("play-button"), playLabel: $("play-label"), seek: $("seek"), currentTime: $("current-time"),
  section: $("section-name"), kicker: $("lyric-kicker"), next: $("lyric-next"), count: $("lyric-count"),
  viewport: $("lyric-viewport"), lines: $("lyric-lines"), intro: $("intro-message"),
  waveform: $("waveform"), pitchCanvas: $("pitch-canvas"), vocal: $("vocal-mode"), key: $("key-select"), volume: $("volume"), hint: $("player-hint"),
  wasmStatus: $("wasm-status"), alignment: $("alignment-chip"), sectionNav: $("section-nav"), micButton: $("mic-button"), micStatus: $("mic-status"),
  micNote: $("mic-note"), micHz: $("mic-hz"), micMeter: $("mic-meter-fill"), micLevel: $("mic-level"), install: $("install-button"), toast: $("toast"),
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
let micContext = null;
let micAnalyser = null;
let micStream = null;
let micFrame = 0;
let toastTimer = 0;
let activeLineIndex = -1;
let lyricRows = [];
let pitchHistory = [];

const VOCAL_AMOUNTS = { original: 0, light: 0.72, strong: 0.94 };
const WASM_INPUT_L = 0;
const WASM_INPUT_R = 131072;
const WASM_OUTPUT_L = 262144;
const WASM_OUTPUT_R = 393216;
const WASM_MIC = 524288;

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(value));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function clamp(value, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3600);
}

async function loadAlignment() {
  const response = await fetch("./alignment.json");
  if (!response.ok) throw new Error(`ALIGNMENT ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.lines) || data.lines.length !== SONG.lines.length) {
    throw new Error("Alignment line count does not match the song data");
  }

  data.lines.forEach((aligned, index) => {
    const line = SONG.lines[index];
    if (line.text !== aligned.text) throw new Error(`Alignment text mismatch at line ${index + 1}`);
    line.start = aligned.start;
    line.end = aligned.end;
    line.tokens = aligned.tokens;
  });

  const visibleSections = SONG.sections.filter((section) => section.lines.length > 0);
  visibleSections.forEach((section) => {
    const sectionLines = SONG.lines.filter((line) => line.sectionId === section.id);
    if (sectionLines.length) {
      section.start = sectionLines[0].start;
      section.end = sectionLines[sectionLines.length - 1].end;
    }
  });
  SONG.sections.forEach((section, index) => {
    if (section.lines.length) return;
    const previous = [...visibleSections].reverse().find((item) => item.index < index);
    const next = visibleSections.find((item) => item.index > index);
    section.start = previous?.end ?? 0;
    section.end = next?.start ?? SONG.duration;
  });

  els.alignment.textContent = "CHARACTER TIMING / LOCAL ASR";
  els.hint.textContent = "歌詞は文字単位のローカル解析タイムラインで追います。";
  renderPosition(audioOffset);
}

async function loadDsp() {
  try {
    const response = await fetch("./dsp.wasm");
    if (!response.ok) throw new Error(`WASM ${response.status}`);
    const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    dsp = result.instance.exports;
    els.wasmStatus.innerHTML = '<span class="status-dot"></span> WASM DSP READY';
  } catch (error) {
    els.wasmStatus.innerHTML = '<span class="status-dot" style="background:var(--orange)"></span> FALLBACK AUDIO';
    els.hint.textContent = "WASMの初期化に失敗しました。原音再生は引き続き利用できます。";
    console.error(error);
  }
}

function buildWaveformData(buffer) {
  const bins = 240;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const data = [];
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin / bins) * buffer.length);
    const end = Math.max(start + 1, Math.floor(((bin + 1) / bins) * buffer.length));
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
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
  const output = audioContext.createBuffer(sourceBuffer.numberOfChannels, sourceBuffer.length, sourceBuffer.sampleRate);
  const memory = new Float32Array(dsp.memory.buffer);
  const left = sourceBuffer.getChannelData(0);
  const right = sourceBuffer.numberOfChannels > 1 ? sourceBuffer.getChannelData(1) : left;
  const outLeft = output.getChannelData(0);
  const outRight = output.numberOfChannels > 1 ? output.getChannelData(1) : outLeft;
  const blockSize = 32768;
  dsp.reset_filter();
  for (let offset = 0; offset < sourceBuffer.length; offset += blockSize) {
    const length = Math.min(blockSize, sourceBuffer.length - offset);
    memory.set(left.subarray(offset, offset + length), WASM_INPUT_L / 4);
    memory.set(right.subarray(offset, offset + length), WASM_INPUT_R / 4);
    dsp.vocal_reduce(WASM_INPUT_L, WASM_INPUT_R, WASM_OUTPUT_L, WASM_OUTPUT_R, length, amount, sourceBuffer.sampleRate);
    outLeft.set(memory.subarray(WASM_OUTPUT_L / 4, WASM_OUTPUT_L / 4 + length), offset);
    if (output.numberOfChannels > 1) outRight.set(memory.subarray(WASM_OUTPUT_R / 4, WASM_OUTPUT_R / 4 + length), offset);
  }
  processedBuffers.set(cacheKey, output);
  return output;
}

async function getActiveBuffer() {
  await loadSourceBuffer();
  const amount = VOCAL_AMOUNTS[els.vocal.value];
  if (amount === 0 || !dsp) return sourceBuffer;
  const cacheKey = amount.toFixed(2);
  if (!processedBuffers.has(cacheKey)) {
    els.hint.textContent = "WASMで中央定位のボーカルを処理中…少し待ってください。";
    await new Promise((resolve) => setTimeout(resolve, 20));
    const processed = processBuffer(amount);
    els.hint.textContent = "音源は端末内で処理されています。通信は不要です。";
    return processed;
  }
  return processedBuffers.get(cacheKey);
}

function currentPosition() {
  if (!audioContext || !isPlaying) return audioOffset;
  const rate = activeSource?.playbackRate.value ?? 2 ** (Number(els.key.value) / 12);
  return Math.min(SONG.duration, audioOffset + (audioContext.currentTime - startedAt) * rate);
}

function stopSource(resetPosition = false) {
  if (activeSource) {
    try { activeSource.stop(); } catch (_) { /* already stopped */ }
    activeSource.disconnect();
    activeSource = null;
  }
  if (isPlaying) audioOffset = currentPosition();
  isPlaying = false;
  if (resetPosition) audioOffset = 0;
  cancelAnimationFrame(raf);
  els.play.classList.remove("playing");
  els.playLabel.textContent = "PLAY";
  renderPosition(audioOffset);
}

async function startPlayback() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") await audioContext.resume();
  const buffer = await getActiveBuffer();
  if (!masterGain) {
    masterGain = audioContext.createGain();
    masterGain.gain.value = Number(els.volume.value);
    masterGain.connect(audioContext.destination);
  }
  const playbackRate = 2 ** (Number(els.key.value) / 12);
  if (audioOffset >= buffer.duration / playbackRate - 0.05) audioOffset = 0;
  activeSource = audioContext.createBufferSource();
  activeSource.buffer = buffer;
  activeSource.playbackRate.value = playbackRate;
  activeSource.connect(masterGain);
  startedAt = audioContext.currentTime;
  activeSource.start(0, audioOffset);
  isPlaying = true;
  els.play.classList.add("playing");
  els.playLabel.textContent = "PAUSE";
  renderLoop();
  activeSource.onended = () => {
    if (isPlaying && currentPosition() >= SONG.duration - .12) {
      audioOffset = 0;
      isPlaying = false;
      activeSource = null;
      els.play.classList.remove("playing");
      els.playLabel.textContent = "PLAY";
      renderPosition(0);
    }
  };
}

async function togglePlayback() {
  if (isPlaying) { stopSource(); return; }
  els.play.disabled = true;
  els.playLabel.textContent = "LOAD";
  try { await startPlayback(); } catch (error) { console.error(error); showToast("音源の読み込みに失敗しました。ページを再読み込みしてください。"); els.playLabel.textContent = "PLAY"; }
  els.play.disabled = false;
}

function charWeight(char) {
  if (/\s/.test(char)) return .35;
  if (/[、。！？「」『』]/.test(char)) return .45;
  return 1;
}

function setCharProgress(row, time, line) {
  const chars = row.querySelectorAll(".lyric-char");
  if (line.tokens?.length === chars.length) {
    chars.forEach((char, index) => {
      const token = line.tokens[index];
      const fill = clamp((time - token.start) / Math.max(.01, token.end - token.start)) * 100;
      char.style.setProperty("--fill", `${fill}%`);
      char.classList.toggle("active", time >= token.start && time < token.end);
    });
    return;
  }
  const weights = [...chars].map((char) => charWeight(char.textContent));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const progress = clamp((time - line.start) / Math.max(.1, line.end - line.start));
  let cursor = 0;
  chars.forEach((char, index) => {
    const start = cursor / total;
    const end = (cursor + weights[index]) / total;
    const fill = clamp((progress - start) / Math.max(.001, end - start)) * 100;
    char.style.setProperty("--fill", `${fill}%`);
    char.classList.toggle("active", progress >= start && progress < end);
    cursor += weights[index];
  });
}

function makeLyricRows() {
  lyricRows = SONG.lines.map((line, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "lyric-line future";
    row.dataset.index = String(index);
    row.setAttribute("aria-label", `${index + 1}行目 ${line.text}`);
    row.addEventListener("click", () => jumpTo(line.start));

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
  for (const section of SONG.sections.filter((item) => item.lines.length > 0)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "section-button";
    button.dataset.sectionId = section.id;
    button.innerHTML = `<small>${section.type}</small>${section.label}`;
    button.addEventListener("click", () => jumpTo(section.start));
    els.sectionNav.append(button);
  }
}

function updateLyricRows(time, lineIndex) {
  const nextIndex = lineIndex >= 0 ? lineIndex + 1 : SONG.lines.findIndex((line) => line.start > time);
  const previousIndex = lineIndex > 0 ? lineIndex - 1 : -1;
  els.lines.classList.toggle("has-current", lineIndex >= 0);
  lyricRows.forEach((row, index) => {
    const line = SONG.lines[index];
    const progress = clamp((time - line.start) / Math.max(.1, line.end - line.start));
    row.classList.toggle("current", index === lineIndex);
    row.classList.toggle("previous", index === previousIndex);
    row.classList.toggle("next-line", index === nextIndex);
    row.classList.toggle("past", index < lineIndex || (lineIndex < 0 && time >= line.end));
    row.classList.toggle("future", index > lineIndex && !(lineIndex < 0 && time >= line.end));
    setCharProgress(row, time, line);
  });

  if (lineIndex !== activeLineIndex) {
    activeLineIndex = lineIndex;
  }
}

function renderPosition(position) {
  const time = Math.min(SONG.duration, Math.max(0, position));
  els.seek.value = String(time);
  els.currentTime.textContent = formatTime(time);
  const lineIndex = SONG.lines.findIndex((line) => time >= line.start && time < line.end);
  const line = lineIndex >= 0 ? SONG.lines[lineIndex] : null;
  const next = SONG.lines.find((item) => item.start > time);
  const section = [...SONG.sections].reverse().find((item) => time >= item.start) ?? SONG.sections[0];
  els.section.textContent = `${section.type} · ${section.label}`;
  els.next.textContent = next ? `NEXT · ${next.text}` : "—";
  els.kicker.textContent = line ? `♪ ${line.section} · ${line.sectionLabel}` : time < SONG.lines[0].start ? "音が始まる。まだ、言葉の前。" : section.type === "INSTRUMENTAL" ? "♪ 間奏 · 次の歌詞まで" : "余韻 · 君がいるうちに";
  els.count.textContent = line ? `${String(lineIndex + 1).padStart(2, "0")} / ${SONG.lines.length}` : next ? `${String(SONG.lines.indexOf(next) + 1).padStart(2, "0")} / ${SONG.lines.length}` : "— / 56";
  els.intro.hidden = Boolean(line);
  if (!line) {
    const label = els.intro.querySelector("strong");
    const note = els.intro.querySelector("span:last-child");
    label.textContent = time < SONG.lines[0].start ? "音が始まる" : section.type === "INSTRUMENTAL" ? "間奏" : "余韻";
    note.textContent = time < SONG.lines[0].start ? "最初の歌詞まで待機中" : section.type === "INSTRUMENTAL" ? "次の歌詞まで聴く" : "曲の終わりまで";
  }
  document.querySelectorAll(".section-button").forEach((button) => button.classList.toggle("active", button.dataset.sectionId === section.id));
  updateLyricRows(time, lineIndex);
  drawWaveform(time);
}

function drawWaveform(time = 0) {
  const canvas = els.waveform;
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 900;
  const height = 50;
  if (canvas.width !== width * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const data = waveformData.length ? waveformData : Array.from({ length: 240 }, (_, index) => .28 + .2 * Math.abs(Math.sin(index * 1.43)) + .13 * Math.abs(Math.sin(index * .31 + 1)));
  const progress = time / SONG.duration;
  const barWidth = width / data.length;
  data.forEach((value, index) => {
    const x = index * barWidth;
    const barHeight = Math.max(3, value * height * .82);
    ctx.fillStyle = index / data.length <= progress ? "#ff5b9e" : "rgba(255,245,238,.2)";
    ctx.fillRect(x, height / 2 - barHeight / 2, Math.max(1, barWidth - 1), barHeight);
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

function jumpTo(time) {
  if (isPlaying) stopSource();
  audioOffset = clamp(time, 0, SONG.duration);
  renderPosition(audioOffset);
}

function updateVolume() { if (masterGain) masterGain.gain.value = Number(els.volume.value); }

async function changeVocalMode() {
  if (!isPlaying) { els.hint.textContent = "次の再生からボーカル設定を適用します。"; return; }
  const position = currentPosition();
  stopSource();
  audioOffset = position;
  await startPlayback();
}

async function changeKey() {
  if (!isPlaying) return;
  const position = currentPosition();
  stopSource();
  audioOffset = position;
  await startPlayback();
}

function noteName(frequency) {
  if (!frequency) return "--";
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  return `${names[(midi + 120) % 12]}${Math.floor(midi / 12) - 1}`;
}

function drawPitchHistory() {
  const canvas = els.pitchCanvas;
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 450;
  const height = canvas.clientHeight || 115;
  if (canvas.width !== width * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const now = performance.now();
  const minMidi = 42;
  const maxMidi = 84;
  ctx.strokeStyle = "rgba(139,231,218,.22)";
  ctx.lineWidth = 1;
  for (let midi = 48; midi <= 84; midi += 12) {
    const y = height - ((midi - minMidi) / (maxMidi - minMidi)) * height;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  const points = pitchHistory.filter((item) => now - item.time < 6000 && item.pitch > 0);
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach((item, index) => {
    const x = width - ((now - item.time) / 6000) * width;
    const midi = 69 + 12 * Math.log2(item.pitch / 440);
    const y = height - clamp((midi - minMidi) / (maxMidi - minMidi)) * height;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#8be7da";
  ctx.lineWidth = 2;
  ctx.stroke();
}

async function toggleMic() {
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    cancelAnimationFrame(micFrame);
    pitchHistory = [];
    els.micButton.classList.remove("active");
    els.micButton.innerHTML = '<span class="mic-symbol">◉</span> マイクを有効化';
    els.micStatus.textContent = "音程と声量を端末内で表示。採点は行いません。";
    els.micNote.textContent = "--";
    els.micHz.textContent = "マイク待機中";
    els.micMeter.style.width = "0";
    els.micLevel.textContent = "0%";
    drawPitchHistory();
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    micContext = new (window.AudioContext || window.webkitAudioContext)();
    const input = micContext.createMediaStreamSource(micStream);
    micAnalyser = micContext.createAnalyser();
    micAnalyser.fftSize = 2048;
    input.connect(micAnalyser);
    els.micButton.classList.add("active");
    els.micButton.innerHTML = '<span class="mic-symbol">●</span> マイクを停止';
    els.micStatus.textContent = "端末内で解析中 · 曲との比較は未実施";
    monitorMic();
  } catch (error) {
    els.micStatus.textContent = "マイクへのアクセスが許可されていません";
    showToast("マイクを使うにはブラウザのアクセス許可が必要です。");
    console.error(error);
  }
}

function monitorMic() {
  if (!micAnalyser || !micStream) return;
  const data = new Float32Array(micAnalyser.fftSize);
  micAnalyser.getFloatTimeDomainData(data);
  let pitch = 0;
  let level = 0;
  if (dsp) {
    const memory = new Float32Array(dsp.memory.buffer);
    memory.set(data, WASM_MIC / 4);
    pitch = dsp.detect_pitch(WASM_MIC, data.length, micContext.sampleRate);
    level = dsp.rms(WASM_MIC, data.length);
  } else {
    level = Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
  }
  els.micNote.textContent = pitch > 0 ? noteName(pitch) : "--";
  els.micHz.textContent = pitch > 0 ? `${Math.round(pitch)} Hz` : "声を入れてください";
  const levelPercent = Math.round(clamp(level * 520) * 100);
  els.micMeter.style.width = `${levelPercent}%`;
  els.micLevel.textContent = `${levelPercent}%`;
  if (pitch > 0 && level > .015) pitchHistory.push({ time: performance.now(), pitch });
  pitchHistory = pitchHistory.filter((item) => performance.now() - item.time < 6000);
  drawPitchHistory();
  micFrame = requestAnimationFrame(monitorMic);
}

window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); installPrompt = event; els.install.hidden = false; });
els.install.addEventListener("click", async () => {
  if (!installPrompt) { showToast("ブラウザの共有メニューから「ホーム画面に追加」を選べます。"); return; }
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  els.install.hidden = true;
});
els.play.addEventListener("click", togglePlayback);
els.seek.addEventListener("input", () => jumpTo(Number(els.seek.value)));
els.volume.addEventListener("input", updateVolume);
els.vocal.addEventListener("change", changeVocalMode);
els.key.addEventListener("change", changeKey);
els.micButton.addEventListener("click", toggleMic);
window.addEventListener("resize", () => { drawWaveform(audioOffset); drawPitchHistory(); });

makeLyricRows();
renderSectionNav();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
loadDsp();
loadAlignment().catch((error) => {
  els.alignment.textContent = "GRID FALLBACK / ALIGNMENT ERROR";
  els.hint.textContent = "文字タイムラインの読み込みに失敗しました。行単位の予備データで再生します。";
  console.error(error);
});
renderPosition(0);
drawWaveform(0);
drawPitchHistory();
