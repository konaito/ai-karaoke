# 俺らのYUMEMI QA記録

## 解析済み入力

- 音源: `俺らのYUMEMI.mp3`, 212.120167秒, SHA-256 `6d4e0b745fa15b2c26f701f0a3627716df4777fe1d02fce91a1c051b7bb8f1da`
- 歌詞: 依頼文の60行を原文として `lyrics-original.txt` に保存
- ASR: 固定 `faster-whisper-small`、区間ごと、`transcripts.provenance.json` に設定とハッシュを保存
- 文字タイミング: `replay` でASR単語時刻から生成。全60行・テキスト一致
- レビュー: `alignment.review.json` に9件。最終コーラスのASR低信頼文字を補間扱いのまま保持

## 採点パケット

- Demucs `htdemucs` / CPU / shifts=0 でボーカル・伴奏を分離
- pYINの採点基準: 637フレーム、31.85秒、60行中43行が0.3秒以上
- `insufficientLines`: `[2,3,12,16,20,21,22,23,24,25,26,27,32,36,48,52,56]`
- 分離ボーカル自己整合: score 100 / coverage 100（実際の人の歌唱精度を示す検査ではない）
- 伴奏側の誤採点確認: score 1.9 / coverage 10

## ローカル画面

- `qa/yumemi-393.png` に393x740の初期画面を保存。`?song=yumemi` で曲名・専用ジャケット・冒頭歌詞が表示され、既定の「聴く」モードになっていることを確認。

## 残る受け入れ境界

この記録は音源由来の自己整合と静的データ検証まで。実マイク、Bluetooth遅延、インストール済みPWA、393x740の実機表示、本番ホストでの再生と採点は公開後に別途確認する。
