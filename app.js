import { SONG } from "./song-data.js";

const $ = (id) => document.getElementById(id);
const els = {
  play: $("play-button"), playLabel: $("play-label"), seek: $("seek"), currentTime: $("current-time"),
  section: $("section-name"), lyricKicker: $("lyric-kicker"), current: $("lyric-current"), next: $("lyric-next"), list: $("lyric-list"),
  waveform: $("waveform"), vocal: $("vocal-mode"), key: $("key-select"), volume: $("volume"), hint: $("player-hint"),
  wasmStatus: $("wasm-status"), micButton: $("mic-button"), micStatus: $("mic-status"), micNote: $("mic-note"), micHz: $("mic-hz"), micMeter: $("mic-meter-fill"),
  install: $("install-button"), toast: $("toast"),
};

let dsp = null;
let sourceBuffer = null;
const processedBuffers = new Map();
let audioContext = null;
let activeSource = null;
let masterGain = null;
let analyser = null;
let audioOffset = 0;
let startedAt = 0;
let isPlaying = false;
let raf = 0;
let installPrompt = null;
let micContext = null;
let micAnalyser = null;
let micStream = null;
let micFrame = null;
let toastTimer = 0;

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

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3600);
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

async function loadSourceBuffer() {
  if (sourceBuffer) return sourceBuffer;
  if (!audioContext) audioContext = new AudioContext();
  const response = await fetch(SONG.source);
  const bytes = await response.arrayBuffer();
  sourceBuffer = await audioContext.decodeAudioData(bytes);
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
  renderPosition(audioOffset);
}

async function startPlayback() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
  const buffer = await getActiveBuffer();
  if (!masterGain) {
    masterGain = audioContext.createGain();
    masterGain.gain.value = Number(els.volume.value);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    masterGain.connect(analyser).connect(audioContext.destination);
  }
  if (audioOffset >= buffer.duration / (2 ** (Number(els.key.value) / 12)) - 0.05) audioOffset = 0;
  activeSource = audioContext.createBufferSource();
  activeSource.buffer = buffer;
  activeSource.playbackRate.value = 2 ** (Number(els.key.value) / 12);
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
      els.play.classList.remove("playing");
      els.playLabel.textContent = "PLAY";
      renderPosition(0);
    }
  };
}

async function togglePlayback() {
  if (isPlaying) {
    stopSource();
    els.play.classList.remove("playing");
    els.playLabel.textContent = "PLAY";
    return;
  }
  els.play.disabled = true;
  els.playLabel.textContent = "LOAD";
  try { await startPlayback(); } catch (error) { console.error(error); showToast("音源の読み込みに失敗しました。ページを再読み込みしてください。"); }
  els.play.disabled = false;
}

function renderPosition(position) {
  const time = Math.min(SONG.duration, Math.max(0, position));
  els.seek.value = String(time);
  els.currentTime.textContent = formatTime(time);
  const lineIndex = SONG.lines.findIndex((line) => time >= line.start && time < line.end);
  const line = lineIndex >= 0 ? SONG.lines[lineIndex] : null;
  const next = lineIndex >= 0 ? SONG.lines[lineIndex + 1] : SONG.lines.find((item) => item.start > time);
  const section = [...SONG.sections].reverse().find((item) => time >= item.start) ?? SONG.sections[0];
  els.section.textContent = section.name;
  els.lyricKicker.textContent = line ? `♪ ${line.section}` : time < SONG.sections[1].start ? "音が始まる。まだ、言葉の前。" : "余韻 / 今日の言葉を返してもらう";
  els.current.textContent = line?.text ?? (time < SONG.sections[1].start ? "愛を伝えるだとか" : "言ってくれる 君がいるうちに");
  els.next.textContent = next?.text ?? "—";
  els.list.replaceChildren(...SONG.lines.slice(Math.max(0, lineIndex + 1), Math.max(0, lineIndex + 4)).map((item) => { const span = document.createElement("span"); span.textContent = item.text; return span; }));
  drawWaveform(time);
}

function drawWaveform(time = 0) {
  const canvas = els.waveform;
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 900;
  const height = 62;
  if (canvas.width !== width * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const progress = time / SONG.duration;
  const bars = Math.max(80, Math.floor(width / 6));
  for (let i = 0; i < bars; i += 1) {
    const x = (i / bars) * width;
    const base = .15 + .18 * Math.abs(Math.sin(i * 1.43)) + .13 * Math.abs(Math.sin(i * .31 + 1));
    const heightValue = base * height * (i / bars < progress ? 1 : .63);
    ctx.fillStyle = i / bars < progress ? "#ff5b9e" : "rgba(255, 245, 238, .19)";
    ctx.fillRect(x, height / 2 - heightValue / 2, 2.4, heightValue);
  }
}

function renderLoop() {
  renderPosition(currentPosition());
  if (isPlaying) raf = requestAnimationFrame(renderLoop);
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

async function toggleMic() {
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    cancelAnimationFrame(micFrame);
    els.micButton.classList.remove("active");
    els.micButton.innerHTML = '<span class="mic-symbol">◉</span> マイクを有効化';
    els.micStatus.textContent = "音程と声量を端末内で表示";
    els.micNote.textContent = "--";
    els.micHz.textContent = "マイク待機中";
    els.micMeter.style.width = "0";
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    micContext = new AudioContext();
    const input = micContext.createMediaStreamSource(micStream);
    micAnalyser = micContext.createAnalyser();
    micAnalyser.fftSize = 2048;
    input.connect(micAnalyser);
    els.micButton.classList.add("active");
    els.micButton.innerHTML = '<span class="mic-symbol">●</span> マイクを停止';
    els.micStatus.textContent = "端末内で解析中";
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
  els.micMeter.style.width = `${Math.min(100, level * 520)}%`;
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
els.seek.addEventListener("input", () => { if (isPlaying) stopSource(); audioOffset = Number(els.seek.value); renderPosition(audioOffset); });
els.volume.addEventListener("input", updateVolume);
els.vocal.addEventListener("change", changeVocalMode);
els.key.addEventListener("change", changeKey);
els.micButton.addEventListener("click", toggleMic);
window.addEventListener("resize", () => drawWaveform(audioOffset));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
loadDsp();
renderPosition(0);
drawWaveform(0);
