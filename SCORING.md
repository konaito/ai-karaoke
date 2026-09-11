# 音程採点 β

スマホUIファーストの練習採点。「採点・音程」→「採点をはじめる」でマイクを許可し、最初から歌う。採点用にはボーカル分離した伴奏を使う。イヤホンを推奨する。音声は録音・保存・送信しない。自己ベストだけを端末に保存する。

## 何を採点するか

自動推定メロディーの信頼できる835フレーム（50ms間隔、計41.75秒、全56フレーズに分布）を対象にする。原音の完全な採譜ではない。信頼度が足りない区間は加点も減点もしない。個別フレーズの対象が0.3秒未満なら「対象不足」と表示する。

- マイク音高と基準音高の差をセントで評価。±25セント以内は満点、そこから±200セントまで線形に減点、それ以上は0点。
- 1オクターブ上下で歌っても許容。キー変更は基準メロディーにも適用。既存のキー変更は再生速度も変わる方式で、独立したピッチシフトではない。
- 対象50msごとに平均するため、更新頻度や同じ音の重複入力で加点は増えない。検出されない対象フレームは0点。無音、歌い飛ばしで高得点を取れない。
- 音程スコア = 対象全フレームの獲得点 / 対象数 × 100。
- 音程一致 = 声が検出された対象フレームのうち、おおむね±50セント以内だった割合。
- 歌えた割合 = 声が検出された対象フレーム数 / 対象数。曲全体の全時間に対する割合ではない。
- 検出3秒・対象5秒未満では点数を出さず、声が足りないと案内。
- 手動終了はその位置までの途中結果。完走結果と区別し、自己ベストを更新しない。
- 採点中のシーク・曲構成ジャンプ・キー／音源／モード／リピート変更を止める。一時停止は可能。アプリが背景に移ったら採点再生を一時停止する。マイク切断時は途中結果を出す。
- 遅延補正は「音づくり」の0〜500msで調整（初期150ms）。解析窓の半分の遅延も引いて基準と照合する。Bluetoothや端末の入出力遅延の自動校正はない。

安定性・抑揚・ビブラート・表現力や、商用カラオケのAI加点は実装していない。DAM／JOYSOUNDと点数を比較するものではない。

## メロディーの生成

[Demucs公式](https://github.com/facebookresearch/demucs)のhtdemucsで音源をボーカルと伴奏に分離し、[librosa pYIN](https://librosa.org/doc/0.11.0/generated/librosa.pyin.html)でボーカルの基本周波数を抽出。音源のSHA-256、処理方法、信頼度、行別カバレッジをmelody.jsonに保存する。

```sh
uv venv /tmp/karaoke-score-env --python 3.11
uv pip install --python /tmp/karaoke-score-env/bin/python demucs==4.0.1 torch==2.5.1 torchaudio==2.5.1 librosa==0.11.0 soundfile
/tmp/karaoke-score-env/bin/python -m demucs -n htdemucs --two-stems vocals --shifts 0 --device cpu -j 4 -o /tmp/karaoke-score-stems audio/track.mp3
/tmp/karaoke-score-env/bin/python scripts/build-melody.py /tmp/karaoke-score-stems/htdemucs/track/vocals.wav
ffmpeg -i /tmp/karaoke-score-stems/htdemucs/track/no_vocals.wav -codec:a libmp3lame -b:a 192k audio/accompaniment.mp3
```

pYIN: 16kHz、2048サンプル窓、160サンプルhop、65〜800Hz。信頼度0.65以上、RMS 0.008以上、歌詞区間の開始／終了から60ms内側を採用。近傍10msの飛躍が1.5半音を超えるフレームは除外。配信クライアント側のマイク検出はscoring.jsのYIN。65〜900Hz、信頼度0.8以上、RMS 0.008以上を採点する。

## 検証

`node --test tests/scoring.test.mjs`：20件。音程一致／外れ、無音、キーとオクターブ、重複サンプリング、未歌唱、低信頼度、基準データ不正、44.1／48kHzの倍音入り既知音高を確認。

`python3 scripts/serve-score-test.py`：127.0.0.1:4191に合成マイク専用テストを起動。実マイクを使わず、C4一定音・8秒のテスト用基準／伴奏で自然終了まで確認する。`/#wrong`は3半音外れ、`/#silent`は無音、`/#denied`は許可拒否。テスト設定はこの専用サーバーだけにあり、通常アプリで有効にする経路はない。

ブラウザ検証：一致入力98.1点（末尾の入力遅延により一部未検出）、3半音外れ0点、無音は採点不能、許可拒否で再生／再試行操作に復帰。320×568の開始画面と結果、393×740、740×360の結果・フレーズ別表示を目視確認。合成結果のスクリーンショットはqa/scoring-synthetic-result.png。

実音源をオフラインでマイク検出器に通した比較：分離歌声100点、分離伴奏4点。qa/vocal-scoring-validation.jsonとqa/backing-scoring-validation.jsonに記録。同じ曲から生成した基準との整合確認であり、独立した人手採譜への精度や実環境の歌唱精度を示す数字ではない。

Android実機のマイク、Bluetooth、スピーカー回り込み、実際の人の歌声での調整は未検証。エコーキャンセルは要求するが、[端末・ブラウザの実設定](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/echoCancellation)による。音楽や録音の再入力を確実に識別する不正防止機能ではない。
