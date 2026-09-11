# 同じ文字タイミングを再現する

このパイプラインは、音源 → 区間ごとの既知歌詞付きASR → 文字タイミング → 静的カラオケ、を保存可能なコマンドにしたものです。元のカラオケの生成コードを作業履歴から回収し、当時の認識結果から `alignment.json` 全体（56行・全トークン・集計）を完全一致で再生成する回帰テストがあります。

実行例はすべて `karaoke/` ディレクトリから。Python 3.11–3.14、uv、ffmpeg / ffprobe が必要です。

## 再現性の二つの境界

- **保存済み認識結果から再生成**：Python標準ライブラリだけで実行でき、元曲の既存JSONとの完全一致を検査できます。新曲も認識結果・入力・補正・出力のSHA-256を保存します。
- **音源から認識をやり直す**：依存関係を `uv.lock`、モデルをコミット `536b0662742c02347bc0e980a01041f333bce120` に固定します。CPU/int8・4スレッド・認識オプションも固定します。ただしOS・CPU・ライブラリの数値演算差によるASR結果の完全一致は保証しません。保存済み認識結果が厳密な再生成の基準です。

YouTubeの再取得でも配信コーデックや音源版が変わる場合があります。同一成果物の再現には、取得済みの `track.mp3` を `source.json` のハッシュとともに保管してください。音源はGitには含めません。

## 既存曲を完全一致で再生成

```bash
python3 pipeline/karaoke.py replay \
  --config examples/ai-wo-tsutaeru/song.json \
  --transcripts examples/ai-wo-tsutaeru/transcripts.json \
  --output work/original-replay.json \
  --expect examples/ai-wo-tsutaeru/expected.json
python3 -m unittest discover -s pipeline -v
```

`legacy_alignment.py` は回収した元コードをそのまま保持しています。区間を絞り、歌詞を `initial_prompt` に入れて faster-whisper-small の単語タイムスタンプを取得。文字列の一致箇所を時刻へ対応付け、置換・欠落箇所は近傍時刻から補間します。セクションごとの絶対秒を使うのでBPMグリッドの累積ズレを持ち込みません。

`confidence` の 0.96 / 0.55 / 0.25 は一致・置換・欠落に付けた**便宜的な値**です。音声モデルの確率や同期精度96%という意味ではありません。`metrics.ratio` も文字列の類似度であり、音と文字のタイミング正解率ではありません。今回の認識結果にはモデル自身の `probability` も別に残しています。

## 指定曲「時定数の低い世界で」を再生成

```bash
uv sync --project pipeline --locked
uv run --project pipeline --locked python pipeline/karaoke.py fetch \
  --url 'https://www.youtube.com/watch?v=XgYgRNQJ13A' \
  --output work/jiteisu-source

python3 pipeline/karaoke.py replay \
  --config examples/jiteisu/song.json \
  --transcripts examples/jiteisu/transcripts.json \
  --output work/jiteisu-replay.json \
  --expect examples/jiteisu/alignment.json

python3 pipeline/karaoke.py build \
  --config examples/jiteisu/song.json \
  --alignment work/jiteisu-replay.json \
  --audio work/jiteisu-source/track.mp3 \
  --output work/jiteisu-player
python3 -m http.server 4178 --directory work/jiteisu-player
```

`http://localhost:4178/` を開きます。取得音源のハッシュが今回のキャプチャと違うとビルドは停止します。その場合は元のキャプチャを使うか、次のコマンドでその音源に対してASRをやり直してください。

```bash
uv run --project pipeline --locked python pipeline/karaoke.py transcribe \
  --config examples/jiteisu/song.json \
  --audio work/jiteisu-source/track.mp3 \
  --output work/jiteisu-new-transcripts.json
python3 pipeline/karaoke.py replay \
  --config examples/jiteisu/song.json \
  --transcripts work/jiteisu-new-transcripts.json \
  --output work/jiteisu-new-alignment.json
```

その出力を `build --alignment` に渡します。既存の取得・認識・ビルド出力は上書きしません。別名の出力先を指定してください。

## 別の曲に使う

`examples/jiteisu/song.json` をコピーし、曲名・歌手・秒数・各区間の `start` / `end` / `lines` を編集します。時刻は曲全体に対する絶対秒。区間はAメロ・サビなど、反復を取り違えない長さに分けます。歌詞は推測せず、正しい原文を用意します。

1. 音源を取得し、ffprobeで再生時間を確認する。
2. 正しい歌詞と大まかな歌唱区間を `song.json` に記録する。
3. `transcribe` で認識結果とモデル・音源・設定のハッシュを保存する。
4. `replay` でタイムラインと `*.review.json` を生成する。
5. 低信頼・行の重複・トークン境界の警告を確認し、該当部分を聴いて必要なら区間を絞り再認識する。
6. 補正をJSONに保存し、`replay --corrections corrections.json` で適用する。
7. `build` で出力し、冒頭・サビ・間奏明け・終盤を再生して確認する。

`algorithm: display-readings-v2` は元方式を保ちつつ、`AI` などの読み展開を表示文字へ戻し、句読点が行の外へはみ出さないようにします。`readings` に表示と読みの対応を指定できます。表示歌詞は保持します。ASRプロンプトだけ変えたい場合は区間の `promptLines` を使います。

補正の形式は0始まりの行番号、対象文字列、理由、変更する境界です。文字境界を直す場合はその行の `tokens` 全体も保存します。

```json
[{"line":0,"text":"対象の歌詞","reason":"音源の入りを確認して修正","start":16.2,"end":20.3,"tokens":[{"text":"対","start":16.2,"end":16.5,"confidence":0.55}]}]
```

上は構造の例です。実データでは `tokens` を全表示文字分入れる必要があり、省略すると検証で停止します。

## 検証と残る制約

元曲の完全一致、誤った認識結果の混入、非数・負数・文字不一致・逆転境界の拒否をテストします。出力プレイヤーは既存のWeb Audio再生・文字塗り・WASMボーカル低減を使います。別曲用に曲名・歌手・再生時間・曲構成・キャッシュを生成し、元曲を上書きしません。

正しい歌詞をプロンプトに与えるため、ASRの文字一致が高くても発声時刻が正しいとは限りません。歌唱専用の音素強制アライメントではなく、読みへの展開内も均等配分です。全区間の試聴・必要な補正は品質確認に残ります。WASMのボーカル低減はセンター成分の低減であり、伴奏ステムの生成や採点ではありません。

## 独立リポジトリの最新UIを使う

UIの更新先は `konaito/ai-karaoke` です。`note` の最新mainはカラオケを管理対象から外しているため、生成作業のディレクトリにその変更を取り込まず、UIを別の場所へ取得します。

```bash
git clone https://github.com/konaito/ai-karaoke.git work/latest-ui
# 取得済みなら: git -C work/latest-ui pull --ff-only
python3 pipeline/karaoke.py build \
  --config examples/jiteisu/song.json \
  --alignment examples/jiteisu/alignment.json \
  --audio work/jiteisu/track.mp3 \
  --template work/latest-ui \
  --cover examples/jiteisu/cover.webp \
  --output work/jiteisu-latest
python3 -m http.server 4288 --bind 127.0.0.1 --directory work/jiteisu-latest
```

`build.json` にUIのコミットと入力ファイルのハッシュも保存します。今回のUIは `3a4251297869e2d650d61a7b8d522eb21ec9873d`。同じUIを再現するときは、このコミットを別のチェックアウトに固定して `--template` に指定してください。

`fetch` はYouTubeサムネイルも `track.webp` として取得します。`build --cover` に渡すと、画面・アイコン・Media Session・オフラインキャッシュへ反映します。指定曲の取得済み画像と取得元URL・SHA-256は `examples/jiteisu/cover.webp` と `source.json` に保存しています。
