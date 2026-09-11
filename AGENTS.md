# Karaoke repository instructions

This is `konaito/ai-karaoke`, the deployed multi-song PWA. Do not pull karaoke changes into the old `konaito/note` repository: its main removes the application. Verify remote, branch, dirty files and current `origin/main` before work. Preserve unrelated changes. Use a `codex/` branch and a PR; inspect new main commits and resolve concurrent changes before merging.

## Adding a song means the entire song

Follow `HARNESS.md`. A song is not complete with just audio/lyrics or a placeholder cover. Required: source audio, actual jacket, authoritative lyrics, captured ASR and character alignment, separated accompaniment, confidence-gated melody, scoring provenance, per-song catalog references, browser QA, cache version update, CI, and (when deployment is requested) a successful Pages run plus live verification.

- Use `pipeline/karaoke.py` for capture/alignment/build and `scripts/prepare-scoring.py` for stems/melody/backing. Preserve inputs, raw captures and corrections. Never overwrite the previous capture to disguise a failed or different run.
- Use `scripts/register-song.py --scoring ...` to register a NEW song. Missing scoring or a placeholder image must fail. For existing unscored songs use `song_harness.py attach-scoring`.
- Melody must match the source audio hash and alignment hash. Do not reuse another song's melody or backing, lower confidence thresholds to make missing phrases disappear, or represent estimated frames as full transcription.
- Review the reported short/uncovered phrases. Test source-vocal self-consistency, wrong notes and silence separately. Synthetic tests are not human singing accuracy. Tell the user the remaining coverage boundary.
- Keep raw stems in ignored `work/`; publish MP3 backing, compact melody and provenance only. Never publish credentials, signed media URLs, caches or virtual environments.
- Preserve the current guide-vocal mix in `mixScoringGuide`; scoring need not mute the original vocal completely. Reference, backing and best score remain keyed by song.

## Commands that must pass

From repository root:

```sh
python3 scripts/song_harness.py check --media
python3 -m unittest discover -s pipeline -v
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/*.test.mjs
node --check app.js
node --check scoring-ui.js
node --check song-data.js
node --check sw.js
git diff --check
```

`--media` needs ffprobe/ffmpeg. ML generation uses Python 3.11 and `uv run --project pipeline/scoring --locked`; it is not run in CI. Do not substitute inferred `pytest` commands for the actual unittest commands.

## Cache and publication

Use `python3 scripts/song_harness.py bump <new-number>` before releasing data or code. It updates the shell, imported modules, JSON requests, worker cache and `release.json` together. An unversioned module previously prevented the entire app from starting. Do not update only `app.js` or only the service worker name.

Verify both songs in one app, including switching during playback, title/cover/duration, song-specific scoring start/results, and 393×740 layout. Use a synthetic-microphone fixture for automated scoring UI checks; never request a real mic just for automation. Inspect actual browser errors and rendered state. Localhost, deployed files, browser emulation and installed-device PWA are distinct evidence.

When authorized to deploy: stage only intended files, push, open/update PR, wait for its exact head's checks, merge, wait for the Pages run for the merge SHA, run `verify-published`, then open the public song URL and exercise playback. Don't declare completion from a push or a successful build alone.

## Harness maintenance

If another step is missed or a new repeatable failure appears, add the concrete sensor or command to `HARNESS.md` and update these instructions. Do not add blanket permission policies, implicit agents or ceremonial approval gates.
