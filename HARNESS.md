# 楽曲追加ハーネス

## 完了条件

「一つのアプリから、その曲を聴ける・歌える・採点できる」を完了条件にする。入口は `AGENTS.md`。実行可能な検証は `scripts/song_harness.py`、CIは `.github/workflows/checks.yml`、デプロイにも同じ検証ゲートを置く。

曲を追加するときの入力は、音源／出典、実際のジャケット、正しい歌詞。指定YouTubeのプレイリストやラジオは取り込まず1曲だけ取得する。原文は `examples/<id>/lyrics-original.txt` に、設定・認識結果・補正・取得元とSHA-256も同じ入力フォルダに保存する。音声認識の文を正しい歌詞とみなさない。

## 1. 音源・ジャケット・歌詞同期

既存の詳細コマンドは [pipeline/README.md](pipeline/README.md)。`fetch` は音源と `track.webp` を取得する。`transcribe` → `replay` → `build --cover ...` で生成する。`*.review.json` の補間を調べ、冒頭・反復サビ・間奏明け・最後を確認する。未確認の文字を高信頼に書き換えない。

この段階の出力は仮ビルドであり、楽曲追加の完了ではない。

## 2. 採点パケットの生成（必須）

```sh
uv run --project pipeline/scoring --locked python scripts/prepare-scoring.py \
  --audio work/new-song-build/audio/track.mp3 \
  --alignment work/new-song-build/alignment.json \
  --output work/new-song-scoring
```

Python 3.11、Demucs 4.0.1 / htdemucs / shifts=0 / CPU、torch 2.5.1、librosa 0.11.0 pYINを固定。音源をボーカルと伴奏に分離し、歌詞区間に入る信頼度0.65以上の安定した音高だけを50msごとに採用する。出力は `melody.json`、`accompaniment.mp3`、`scoring-provenance.json`、生成コマンド履歴。モデル重み、音源・歌詞・ステム・出力のSHA-256も保存する。

ASR・MLを別のCPU/OSで再実行した結果のバイト一致は保証しない。固定入力とキャプチャからの再生成、保存成果物のハッシュ照合を再現性の基準にする。

```sh
node scripts/verify-pitch.mjs \
  work/new-song-scoring/melody.json \
  work/new-song-scoring/stems/htdemucs/track/vocals.wav \
  work/new-song-scoring/accompaniment.mp3 \
  work/new-song-scoring/pitch-validation.json
```

実装中のマイク検出器で分離歌声を検査し、点数80以上・検出率80%以上を下回ったら止まって原因を調べる。伴奏側の点数も報告する。これは同一音源由来の自己整合テストで、人手採譜や実際の歌唱との独立した精度検証ではない。

`insufficientLines` は0始まり。0.3秒未満の対象しかない行を列挙する。最低5秒の採点基準がなければ登録しない。対象不足の行は無理に埋めず結果画面に「対象不足」と表示する。秒数・十分なフレーズ数を開始前に表示する。正解音程のない箇所は加点も減点もしない。

## 3. 登録（欠落があれば失敗）

```sh
python3 scripts/register-song.py --id new-song \
  --build work/new-song-build --scoring work/new-song-scoring
```

表示歌詞、実画像、音源／採点ハッシュ、伴奏の長さを確認してから `songs/<id>/` と `catalog.json` に登録する。`--scoring` は省略不可。登録済みIDは上書きしない。

今回のように登録済みの曲へ採点を追加する場合:

```sh
python3 scripts/song_harness.py attach-scoring \
  --song jiteisu --from-dir work/jiteisu-scoring
```

既存の元曲だけは `legacy-verified` の来歴を保持する。既存ファイルのハッシュは検証しているが、当時の生成環境を完全復元したとは扱わない。新曲にこの例外を使わない。

## 4. 公開前ゲート

```sh
python3 scripts/song_harness.py bump 24  # 次回は現在値より新しい番号
python3 scripts/song_harness.py check --media
python3 -m unittest discover -s pipeline -v
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/*.test.mjs
```

検証対象: 必須6アセット、実画像のマジックバイト、文字の対応、時刻の有限性と範囲、別曲データの混入、メロディーの順序／音高／信頼度／行番号、カバレッジ再集計、伴奏尺、オフラインキャッシュ一覧、依存モジュールのバージョン一致。欠落があるとCI・本番デプロイのゲートを通らない。

ブラウザでは通常再生と聴くモード、曲の往復、再生中の切り替えで停止、ジャケットと尺、採点開始→結果、結果画面の曲名・歌手、対象不足行、393×740の見切れを確認。合成マイクは `python3 scripts/serve-score-test.py --song <id> --port 4191` で起動するローカル専用サーバーを使う。`#wrong` / `#silent` / `#denied` は外れ／無音／許可拒否。合成モードを公開アプリに混ぜない。

## 5. PR・マージ・公開後検証

依頼に公開が含まれている場合だけ、その認可を引き継いでデプロイする。mainの進行を確認し、別作業を消さずに競合を解消する。PRの最新headのCI成功を確認してマージし、設定済みのVercel本番配信を実行する。

```sh
python3 scripts/song_harness.py verify-published --song new-song
```

曲一覧・コード・音源・画像・歌詞・採点・伴奏・来歴を本番URLから取り直し、ローカルとバイト照合する。その後 `https://<production-host>/?song=new-song&v=<version>` を開き、実際の切り替え・再生・採点画面を確認して完了を伝える。ネットワーク照合だけで画面検証の代わりにしない。

## 今回の境界とメンテナンス

「時定数の低い世界で」は482フレーム・24.1秒が採点対象。十分な対象がある行は23/45行。残りは対象不足として明示し、全45行の完全採譜とは表現しない。実機のマイク・Bluetooth遅延・人の歌声による受け入れは別途必要。

新たな省略・キャッシュ事故・検証漏れを見つけたら、手順だけでなく失敗するテストを追加する。データ生成の閾値やUIが変わったら、スクリプト・説明・CIを一緒に更新する。
