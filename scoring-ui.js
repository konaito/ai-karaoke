import {
  PitchDetector,
  ScoreSession,
  validateReference,
  frequencyToMidi,
  pitchError,
} from "./scoring.js?v=26";

export function createScoringController(api) {
  const $ = (id) => document.getElementById(id);
  const canvas = $("pitch-canvas");
  const detector = new PitchDetector();
  let reference = null,
    referencePromise = null;
  let session = null,
    active = false,
    pending = false;
  let context = null,
    stream = null,
    source = null,
    analyser = null,
    timer = 0;
  let samples = new Float32Array(4096),
    trace = [],
    lastDraw = 0,
    lastUI = 0;
  let lastResult = null,
    page = 0,
    returnFocus = null;
  const locked = [
    "song-select",
    "seek",
    "previous-phrase",
    "next-phrase",
    "repeat-button",
    "key-select",
    "vocal-mode",
    "vocal-toggle",
    "latency",
  ];

  function loadReference() {
    const requestedUrl = api.referenceUrl;
    if (!referencePromise)
      referencePromise = fetch(`${api.referenceUrl}?v=26`)
        .then((response) => {
          if (!response.ok) throw new Error("Reference unavailable");
          return response.json();
        })
        .then((data) => {
          if (requestedUrl !== api.referenceUrl) return null;
          reference = validateReference(data);
          const seconds = reference.frames.length * reference.step;
          const covered = (reference.lineCoverageSeconds ?? []).filter(t => t >= .3).length;
          $("mic-status").textContent = `自動推定 · 採点対象 ${seconds.toFixed(1)}秒 · ${covered}/${api.lineCount}フレーズ`;

          draw();
          return reference;
        })
        .catch((error) => {
          if (requestedUrl !== api.referenceUrl) return null;
          referencePromise = null;
          throw error;
        });
    return referencePromise;
  }
  function lock(value) {
    for (const id of locked) $(id).disabled = value;
    document
      .querySelectorAll("[data-playback-mode],.section-button")
      .forEach((button) => {
        button.disabled = value;
      });
    document.body.classList.toggle("scoring-active", value);
  }
  function stopMic() {
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    source?.disconnect();
    stream = null;
    source = null;
    analyser = null;
    if (context) void context.close().catch(() => {});
    context = null;
    $("mic-meter-fill").style.width = "0%";
    $("mic-level").textContent = "0%";
    $("mic-note").textContent = "—";
    $("mic-hz").textContent = "マイク待機中";
    $("pitch-feedback").textContent = "イヤホンをつけて、最初から採点";
    $("mic-button").classList.remove("active");
    $("mic-button").textContent = "採点をはじめる";
    $("mic-button").disabled = false;
  }
  async function toggle() {
    if (!api.referenceUrl) { api.toast("この曲は採点準備中です。うたう・聴くは利用できます。"); return; }
    if (active) {
      finish(api.position(), false);
      return;
    }
    if (pending) return;
    pending = true;
    $("play-button").disabled = true;
    lock(true);
    $("mic-button").disabled = true;
    $("mic-button").textContent = "準備中…";
    api.pause();
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("MIC_UNAVAILABLE");
      await loadReference();
      // Allocate/resume audio in the start gesture before downloading/processing.
      context = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
      });
      await context.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      source.connect(analyser);
      session = new ScoreSession(reference, { key: api.key() });
      trace = [];
      await api.restart();
      active = true;
      $("play-button").disabled = false;
      $("mic-button").textContent = "終了して結果を見る";
      $("mic-button").classList.add("active");
      $("mic-button").disabled = false;
      $("mic-status").textContent = "イヤホン推奨 · オクターブ上下でも採点";
      $("score-live").textContent = "—";
      $("pitch-feedback").textContent = "歌い出しを待っています";
      stream.getAudioTracks()[0].addEventListener("ended", () => {
        if (active) {
          api.toast("マイクが切断されたため、ここまでの結果を表示します。");
          finish(api.position(), false);
        }
      });
      sample();
    } catch (error) {
      active = false;
      session = null;
      stopMic();
      lock(false);
      $("pitch-feedback").textContent = "採点を開始できませんでした";
      const denied = ["NotAllowedError", "PermissionDeniedError"].includes(
        error.name,
      );
      api.toast(
        denied
          ? "マイクの使用を許可して、もう一度お試しください。"
          : "採点の準備に失敗しました。通信とマイクの接続をご確認ください。",
      );
    } finally {
      pending = false;
      $("play-button").disabled = false;
    }
  }
  function sample() {
    if (!active || !analyser || !context) return;
    analyser.getFloatTimeDomainData(samples);
    const { hz, rms, confidence } = detector.detect(
      samples,
      context.sampleRate,
    );
    const level = Math.min(100, Math.round(rms * 500));
    $("mic-meter-fill").style.width = `${level}%`;
    $("mic-level").textContent = `${level}%`;
    $("mic-note").textContent = hz ? noteName(frequencyToMidi(hz)) : "—";
    $("mic-hz").textContent = hz ? `${Math.round(hz)} Hz` : "声を待っています";
    if (api.playing()) {
      const latency =
        Number($("latency").value) / 1000 +
        samples.length / context.sampleRate / 2;
      const time = Math.max(
        0,
        api.position() - latency * 2 ** (api.key() / 12),
      );
      const match = session.add(time, hz, confidence);
      const target = session.targetAt(time);
      if (hz)
        trace.push({ time, midi: frequencyToMidi(hz), error: match?.error });
      trace = trace.filter((point) => point.time > time - 3);
      $("pitch-feedback").textContent = !target
        ? api.inLyrics(time)
          ? "この区間は採点対象外"
          : "次のフレーズを待っています"
        : !hz
          ? "声を入れてください"
          : Math.abs(match?.error ?? 999) <= 50
            ? "音程ぴったり"
            : (match?.error ?? 0) > 0
              ? "少し低く歌おう ↓"
              : "少し高く歌おう ↑";
      const now = performance.now();
      if (now - lastUI > 250) {
        const result = session.result(time);
        $("score-live").textContent =
          result.score === null ? "—" : result.score.toFixed(1);
        lastUI = now;
      }
    } else $("pitch-feedback").textContent = "一時停止中 · 再生で続ける";
    draw();
    timer = setTimeout(sample, 25);
  }
  function noteName(midi) {
    const note = Math.round(midi),
      names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
    return names[((note % 12) + 12) % 12] + (Math.floor(note / 12) - 1);
  }
  function draw() {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    const now = performance.now();
    if (now - lastDraw < 30) return;
    lastDraw = now;
    const width = canvas.clientWidth,
      height = canvas.clientHeight,
      ratio = devicePixelRatio || 1;
    if (
      canvas.width !== Math.round(width * ratio) ||
      canvas.height !== Math.round(height * ratio)
    ) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const position = api.position(),
      start = position - 2,
      end = position + 4;
    const frames =
      reference?.frames.filter(
        (frame) => frame[0] >= start && frame[0] <= end,
      ) ?? [];
    const pitches = frames.map((frame) => frame[1] + api.key());
    const center = pitches.length
      ? pitches.slice().sort((a, b) => a - b)[Math.floor(pitches.length / 2)]
      : 60;
    const min = Math.min(center - 5, ...pitches.map((x) => x - 2)),
      max = Math.max(center + 5, ...pitches.map((x) => x + 2));
    const y = (midi) =>
      height - 9 - ((midi - min) / (max - min)) * Math.max(1, height - 18);
    const x = (time) => ((time - start) / 6) * width;
    ctx.font = "9px sans-serif";
    ctx.textBaseline = "middle";
    for (let midi = Math.ceil(min); midi <= max; midi++) {
      ctx.strokeStyle = midi % 12 === 0 ? "#48594a" : "#2b3b30";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y(midi));
      ctx.lineTo(width, y(midi));
      ctx.stroke();
      if (midi % 12 === 0) {
        ctx.fillStyle = "#8e9c8e";
        ctx.fillText(noteName(midi), 2, y(midi) - 5);
      }
    }
    ctx.fillStyle = "#c9e68c";
    for (const [time, midi] of frames)
      ctx.fillRect(
        x(time),
        y(midi + api.key()) - 2,
        Math.max(2, (reference.step / 6) * width + 1),
        4,
      );
    ctx.strokeStyle = "#ffffff70";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(position), 0);
    ctx.lineTo(x(position), height);
    ctx.stroke();
    for (let i = 1; i < trace.length; i++) {
      const a = trace[i - 1],
        b = trace[i];
      if (b.time - a.time > 0.15) continue;
      // Display the accepted octave next to the target lane, matching scoring.
      const toLane = (midi) => midi + Math.round((center - midi) / 12) * 12;
      ctx.strokeStyle = Math.abs(b.error ?? 999) <= 50 ? "#6de3d1" : "#fc8999";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x(a.time), y(toLane(a.midi)));
      ctx.lineTo(x(b.time), y(toLane(b.midi)));
      ctx.stroke();
    }
    if (!frames.length) {
      ctx.fillStyle = "#9da69f";
      ctx.font = "11px sans-serif";
      ctx.fillText(
        reference
          ? api.inLyrics(position)
            ? "この区間は採点対象外"
            : "前奏・間奏"
          : "ガイドを準備しています",
        12,
        height / 2,
      );
    }
  }
  function finish(time, completed) {
    if (!active) return;
    active = false;
    lastResult = session.result(completed ? Infinity : time);
    lastResult.completed = completed;
    lastResult.at = new Date().toISOString();
    stopMic();
    lock(false);
    api.pause();
    api.beforeResults();
    if (completed && lastResult.enough) {
      try {
        const storageKey = `karaoke-best-${api.songId}-${lastResult.version}-${lastResult.referenceVersion}-${lastResult.key}`;
        const best = Number(localStorage.getItem(storageKey) || 0);
        $("score-best").textContent =
          lastResult.score > best
            ? "自己ベスト！"
            : `自己ベスト ${best.toFixed(1)}`;
        localStorage.setItem(
          storageKey,
          String(Math.max(best, lastResult.score)),
        );
      } catch {
        $("score-best").textContent = "";
      }
    } else $("score-best").textContent = completed ? "" : "途中までの練習結果";
    $("score-scope").textContent =
      `採点対象 ${lastResult.expectedSeconds.toFixed(1)} 秒 · 検出 ${lastResult.voicedSeconds.toFixed(1)} 秒`;
    $("score-value").textContent =
      lastResult.score === null ? "—" : lastResult.score.toFixed(1);
    $("score-accuracy").textContent =
      lastResult.accuracy === null ? "—" : `${lastResult.accuracy}%`;
    $("score-coverage").textContent = `${lastResult.coverage}%`;
    $("score-comment").textContent = !lastResult.enough
      ? "採点できる声が足りませんでした。イヤホンをつけて、マイクに向かって歌ってみよう。"
      : lastResult.coverage < 60
        ? "歌えた区間を増やそう。声が小さいときは、マイクを少し近づけて。"
        : lastResult.score >= 85
          ? "メロディーをしっかり捉えています。この調子で一曲を歌いきろう。"
          : "ガイドの高さを聴いて、苦手なフレーズからもう一度。";
    page = 0;
    renderPhrases();
    selectResultTab("summary");
    openResult(true);
  }
  function openResult(open) {
    $("score-result").hidden = !open;
    document.querySelector(".karaoke-app").inert = open;
    if (open) {
      returnFocus = document.activeElement;
      $("close-score").focus();
    } else {
      returnFocus?.focus();
      returnFocus = null;
    }
  }
  function selectResultTab(name) {
    $("score-summary").hidden = name !== "summary";
    $("score-phrases").hidden = name !== "phrases";
    document
      .querySelectorAll("[data-result-tab]")
      .forEach((button) =>
        button.setAttribute(
          "aria-selected",
          String(button.dataset.resultTab === name),
        ),
      );
  }
  function renderPhrases() {
    const measured = new Map((lastResult?.lines ?? []).map(row => [row.line, row]));
    const rows = lastResult?.completed ? Array.from({length: api.lineCount}, (_, line) => measured.get(line) ?? {line, sufficient:false, score:null}) : (lastResult?.lines ?? []),
      pages = Math.max(1, Math.ceil(rows.length / 4));
    page = Math.max(0, Math.min(page, pages - 1));
    $("score-page").textContent = `${page + 1} / ${pages}`;
    $("score-prev").disabled = page === 0;
    $("score-next").disabled = page === pages - 1;
    $("score-phrase-list").replaceChildren(
      ...rows.slice(page * 4, page * 4 + 4).map((row) => {
        const li = document.createElement("li"),
          text = document.createElement("span"),
          value = document.createElement("strong");
        text.textContent = api.lineText(row.line);
        value.textContent = !row.sufficient
          ? "対象不足"
          : row.score === null
            ? "未歌唱"
            : `${row.score}点`;
        li.append(text, value);
        return li;
      }),
    );
  }
  $("close-score").addEventListener("click", () => openResult(false));
  $("score-retry").addEventListener("click", () => {
    openResult(false);
    api.show();
    void toggle();
  });
  $("score-prev").addEventListener("click", () => {
    page--;
    renderPhrases();
  });
  $("score-next").addEventListener("click", () => {
    page++;
    renderPhrases();
  });
  document
    .querySelectorAll("[data-result-tab]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        selectResultTab(button.dataset.resultTab),
      ),
    );
  $("latency").addEventListener("input", () => {
    $("latency-value").textContent = `${$("latency").value} ms`;
  });
  document.addEventListener("visibilitychange", () => {
    if (active && document.hidden) api.pause();
  });
  document.addEventListener("keydown", (event) => {
    if ($("score-result").hidden) return;
    if (event.key === "Escape") {
      openResult(false);
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...$("score-result").querySelectorAll("button")].filter(
        (e) => e.getClientRects().length && !e.disabled,
      ),
      first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  window.addEventListener("pagehide", () => {
    active = false;
    stopMic();
    lock(false);
  });
  if (!api.referenceUrl) {
    $("mic-button").disabled = true;
    $("mic-button").textContent = "この曲の採点は準備中";
    $("mic-status").textContent = "歌詞を見ながら歌う・聴くことができます。";
    $("pitch-feedback").textContent = "この曲の採点データは未登録です。";
  } else loadReference().catch(() => {
    $("pitch-feedback").textContent = "ガイドを読み込めません。開始時に再試行します。";
  });
  return {
    setSong(songId, referenceUrl) {
      api.songId = songId;
      api.referenceUrl = referenceUrl;
      reference = null;
      referencePromise = null;
      session = null;
      trace = [];
      lastResult = null;
      $("score-result").hidden = true;
      $("mic-button").disabled = !referenceUrl;
      $("mic-button").textContent = referenceUrl ? "採点をはじめる" : "この曲の採点は準備中";
      $("pitch-feedback").textContent = referenceUrl ? "イヤホンをつけて、最初から採点" : "この曲の採点データは未登録です。";
      $("mic-status").textContent = referenceUrl ? "イヤホンをつけて採点を開始できます。" : "歌詞を見ながら歌う・聴くことができます。";
      draw();
      if (referenceUrl) loadReference().catch(() => {
        $("pitch-feedback").textContent = "ガイドを読み込めません。開始時に再試行します。";
      });
    },
    toggle,
    draw,
    finish,
    get active() {
      return active;
    },
    get locked() {
      return active || pending;
    },
  };
}
