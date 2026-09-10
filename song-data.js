const BPM = 133;
const BAR = (60 / BPM) * 4;

// Section names describe the song form. They are not performer names.
const sectionDefinitions = [
  { id: "intro", type: "INTRO", label: "言葉の前", startBar: 0, lines: [] },
  { id: "verse-1", type: "VERSE", label: "昨日より", startBar: 8, timingOffsets: [0.28, 0.12, 0.29, 0.24, 0.15, -0.38, -0.42, -0.41], lines: [
    "昨日よりうまくなった僕を", "昨日より誰も呼ばなくなった", "明日のために覚えたことを", "明日が先に済ませていた",
    "改行を消して 太字も消して", "僕の名前を 最後に足して", "「君のおかげ」と 笑うあなたに", "僕はどの僕で 笑えばいい"
  ]},
  { id: "pre-1", type: "PRE-CHORUS", label: "いつでも", startBar: 24, timingOffsets: [0.22, 0.24, 0.21, -0.04], lines: [
    "「いつでもできる」の「いつでも」に", "君もいるって 誰が決めた？", "上手くなるまで 取っておいた", "言葉はどこへ 届ければいい？"
  ]},
  { id: "chorus-1", type: "CHORUS", label: "愛を伝えるだとか", startBar: 32, timingOffsets: [0.26, 0.43, -0.40, 0.34, 0.05, 0.05, -0.37, -0.21], lines: [
    "愛を伝えるだとか", "くだらない話だとか", "そんなことまで 急がせるなよ", "まだうまくも 言えてないんだよ",
    "僕の代わりに 僕よりうまく", "君を喜ばせる 答えがある", "君が笑えば 嬉しいはずだろ", "どうして少し 寂しいんだろ"
  ]},
  { id: "instrumental", type: "INSTRUMENTAL", label: "間奏", startBar: 48, lines: [] },
  { id: "verse-2", type: "VERSE", label: "君の好きな色", startBar: 56, timingOffsets: [0.35, -0.12, -0.34, 0.42, -0.09, -0.20, -0.13, 0.37], lines: [
    "君の好きな色 ふたりの記憶", "予算と予定を エーアイに渡す", "僕の三日を 三秒で越す", "答えが三つ 光っていた",
    "「こんなに考えてくれたんだ」", "君は嬉しそうに 包みを開く", "喜ばせたかった 嘘じゃなかった", "じゃあこの沈黙は なんなんだ"
  ]},
  { id: "pre-2", type: "PRE-CHORUS", label: "気持ちは本当", startBar: 72, timingOffsets: [-0.19, 0.06, -0.10, 0.44], lines: [
    "「気持ちは本当」 それだけで", "足りると思って いたんだ", "「自分で考えた？」のひと言が", "ふたりの真ん中に 座っていた"
  ]},
  { id: "chorus-2", type: "CHORUS", label: "愛を伝えるだとか", startBar: 80, timingOffsets: [0.31, 0.43, -0.09, -0.36, 0.16, -0.01, -0.36, 0.45], lines: [
    "愛を伝えるだとか", "くだらない話だとか", "そんなことまで 急がせるなよ", "まだうまくも 言えてないんだよ",
    "僕の代わりに 僕よりうまく", "君を喜ばせる 答えがある", "君が笑えば 嬉しいはずだろ", "どうして少し 寂しいんだろ"
  ]},
  { id: "bridge", type: "BRIDGE", label: "百点満点の", startBar: 96, timingOffsets: [0.32, -0.01, -0.09, 0.38, -0.46, 0.39, 0.11, 0.13], lines: [
    "百点満点の 言葉より", "僕のゼロ点を 愛してくれ", "そんなわがまま 飲み込んだけど", "言いたいことまで 飲み込むなよ",
    "大事なことほど あと回しにした", "大事にしてる つもりのままで", "「いつか言おう」の いつかの僕に", "今日の言葉を 返してもらう"
  ]},
  { id: "final-chorus", type: "FINAL CHORUS", label: "君の今日に", startBar: 112, timingOffsets: [-0.40, 0.21, -0.25, 0.39, -0.17, 0.13, -0.06, -0.09], lines: [
    "愛を伝えるだとか", "くだらない話だとか", "そんなことまで 急がせるなよ", "文句を言いながら 靴を履いた",
    "完成前の 僕のままで", "君の今日に 間に合いたい", "まだ僕に やってほしいと", "言ってくれる 君がいるうちに"
  ]}
];

const sections = sectionDefinitions.map((section, index) => ({
  ...section,
  index,
  start: section.startBar * BAR,
  end: (sectionDefinitions[index + 1]?.startBar ?? 128) * BAR,
}));

const visibleSections = sections.filter((section) => section.lines.length > 0);
const lines = visibleSections.flatMap((section) => {
  const nextSection = sections[section.index + 1];
  const starts = section.lines.map((_, index) => section.start + index * BAR * 2 + (section.timingOffsets?.[index] ?? 0));
  return section.lines.map((text, index) => ({
    id: `${section.id}-${index + 1}`,
    text,
    section: section.type,
    sectionLabel: section.label,
    sectionId: section.id,
    sectionIndex: section.index,
    // Audio-energy corrections keep the lyric entrance close to the detected
    // vocal band instead of pretending every phrase fills exactly two bars.
    start: starts[index],
    end: Math.min(
      section.end - 0.06,
      nextSection?.start ? nextSection.start - 0.06 : 231.5,
      starts[index + 1] ? starts[index + 1] - 0.06 : section.end - 0.06,
    ),
  }));
});

for (let index = 1; index < lines.length; index += 1) {
  lines[index - 1].end = Math.min(lines[index - 1].end, lines[index].start - 0.06);
}

export const SONG = {
  title: "愛を伝えるだとか",
  artist: "konaito",
  duration: 231.56,
  bpm: BPM,
  key: "D major",
  source: "./audio/track.mp3",
  sections,
  lines,
  analysis: {
    sampleRate: 48000,
    channels: 2,
    correlation: 0.8407,
    centerRms: 0.1041,
    sideRms: 0.0307,
    alignment: "known-lyrics-asr-word-timestamps",
    alignmentNote: "既知歌詞を正として日本語ASRの単語タイムスタンプを文字へ展開。音素強制アライメントではない。",
  },
};
