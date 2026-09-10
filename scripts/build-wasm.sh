#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cargo build --manifest-path "$ROOT_DIR/wasm/Cargo.toml" --target wasm32-unknown-unknown --release
cp "$ROOT_DIR/wasm/target/wasm32-unknown-unknown/release/karaoke_dsp.wasm" "$ROOT_DIR/dsp.wasm"
echo "Built dsp.wasm"
