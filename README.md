# 愛を伝えるだとか / KARAOKE

このディレクトリは、`愛を伝えるだとか` 一曲だけの静的PWAです。音源・歌詞・ボーカル低減・マイクの音程検出はブラウザ内で動き、サーバーへ音声データを送信しません。

## ローカルで確認

```bash
cd karaoke
python3 -m http.server 4173
```

`http://localhost:4173/` を開きます。`file://` 直開きでは、Service WorkerとWASMのために正しく動作しません。

## WASMを再ビルド

```bash
./karaoke/scripts/build-wasm.sh
```

`wasm/src/lib.rs` のDSPは、中央定位の高域成分を抑え、低域の中央成分を残すボーカル低減と、マイクのRMS/自己相関ピッチ検出を担当します。

## GitHub Pages

`.github/workflows/karaoke-pages.yml` は `main` の `karaoke/` 配下が更新されたとき、ディレクトリをそのままPagesへデプロイします。GitHubリポジトリの Settings → Pages → Source を `GitHub Actions` に設定してください。

## 既知の制約

このWAVは完成済みのステレオミックスで、分離済みボーカル/伴奏ステムではありません。そのため、アプリの「ボーカル低減」は機械学習による完全なステム分離ではなく、中央定位成分をWASMで抑える方式です。声の残響や中央のスネア/ベースが少し残る場合があります。
