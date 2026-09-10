const BPM = 133;
const BAR = (60 / BPM) * 4;

const sectionDefinitions = [
  { name: "INTRO / 言葉の前", startBar: 0, lines: [] },
  { name: "VERSE 1 / 昨日より", startBar: 8, lines: [
    "昨日よりうまくなった僕を", "昨日より誰も呼ばなくなった", "明日のために覚えたことを", "明日が先に済ませていた",
    "かいぎょうを消して ふとじも消して", "僕の名前を 最後に足して", "「君のおかげ」と 笑うあなたに", "僕はどの僕で 笑えばいい"
  ]},
  { name: "PRE-CHORUS / いつでも", startBar: 24, lines: [
    "「いつでもできる」の「いつでも」に", "君もいるって 誰が決めた？", "上手くなるまで 取っておいた", "言葉はどこへ 届ければいい？"
  ]},
  { name: "CHORUS / 愛を伝えるだとか", startBar: 32, lines: [
    "愛を伝えるだとか", "くだらない話だとか", "そんなことまで 急がせるなよ", "まだうまくも 言えてないんだよ",
    "僕の代わりに 僕よりうまく", "君を喜ばせる 答えがある", "君が笑えば 嬉しいはずだろ", "どうして少し 寂しいんだろ"
  ]},
  { name: "INSTRUMENTAL / 間奏", startBar: 48, lines: [] },
  { name: "VERSE 2 / 君の好きな色", startBar: 56, lines: [
    "君の好きな色 ふたりの記憶", "予算と予定を エーアイに渡す", "僕の三日を 三秒で越す", "答えが三つ 光っていた",
    "「こんなに考えてくれたんだ」", "君は嬉しそうに 包みを開く", "喜ばせたかった 嘘じゃなかった", "じゃあこの沈黙は なんなんだ"
  ]},
  { name: "PRE-CHORUS / 気持ちは本当", startBar: 72, lines: [
    "「気持ちは本当」 それだけで", "足りると思って いたんだ", "「自分で考えた？」のひと言が", "ふたりの真ん中に 座っていた"
  ]},
  { name: "CHORUS / 愛を伝えるだとか", startBar: 80, lines: [
    "愛を伝えるだとか", "くだらない話だとか", "そんなことまで 急がせるなよ", "まだうまくも 言えてないんだよ",
    "僕の代わりに 僕よりうまく", "君を喜ばせる 答えがある", "君が笑えば 嬉しいはずだろ", "どうして少し 寂しいんだろ"
  ]},
  { name: "BRIDGE / 百点満点の", startBar: 96, lines: [
    "百点満点の 言葉より", "僕のゼロ点を 愛してくれ", "そんなわがまま 飲み込んだけど", "言いたいことまで 飲み込むなよ",
    "大事なことほど あと回しにした", "大事にしてる つもりのままで", "「いつか言おう」の いつかの僕に", "今日の言葉を 返してもらう"
  ]},
  { name: "FINAL CHORUS / 君の今日に", startBar: 112, lines: [
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

const lines = sections.flatMap((section) => section.lines.map((text, index) => ({
  text,
  section: section.name,
  sectionIndex: section.index,
  start: section.start + index * BAR * 2,
  end: section.start + (index + 1) * BAR * 2,
})));

export const SONG = {
  title: "愛を伝えるだとか",
  artist: "konaito",
  duration: 231.56,
  bpm: BPM,
  key: "D major",
  source: "./audio/track.mp3",
  sections,
  lines,
  analysis: { sampleRate: 48000, channels: 2, correlation: 0.8407, centerRms: 0.1041, sideRms: 0.0307 },
};
