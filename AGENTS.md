# Karaoke HQ instructions

This directory is the canonical home for the karaoke application and its song-analysis pipeline. Work here and in `konaito/ai-karaoke`; do not create or maintain a parallel `note/karaoke` copy. Verify the remote, branch, dirty files, and current `origin/main` before work. Preserve unrelated changes. Use a `codex/` branch and a PR.

## Song onboarding

Follow `HARNESS.md`. A song is incomplete until its source audio, authoritative lyrics, captured ASR and replayable character timing, real jacket, separated accompaniment, confidence-gated melody, scoring provenance, per-song catalog references, browser QA, cache version update, CI, and (when deployment is requested) a successful configured GitHub Pages deployment plus live verification are present.

- Use `pipeline/karaoke.py` for capture/alignment/build and `scripts/prepare-scoring.py` for stems/melody/backing. Preserve inputs, raw captures and corrections. Never overwrite the previous capture to disguise a failed or different run.
- Use `scripts/register-song.py --scoring ...` to register a new song. Missing scoring or a placeholder image must fail. For existing unscored songs use `song_harness.py attach-scoring`.
- Melody must match the source audio hash and alignment hash. Do not reuse another song's melody or backing, lower confidence thresholds to make missing phrases disappear, or represent estimated frames as full transcription.
- Review the reported short or uncovered phrases. Test source-vocal self-consistency, wrong notes and silence separately. Synthetic tests are not human singing accuracy. Tell the user the remaining coverage boundary.
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

Use `python3 scripts/song_harness.py bump <new-version>` before releasing data or code. It updates the app modules, JSON requests, worker cache and `release.json` together. Verify all songs in one app, including switching during playback, listening and karaoke modes, song-specific scoring, and the 393x740 layout. Localhost, deployed files, browser emulation and installed-device PWA are distinct evidence.

When authorized to deploy: stage only intended files, push, open or update a PR, wait for its exact head's checks, merge, wait for the Pages run for the merge SHA, run `verify-published` against `https://konaito.github.io/ai-karaoke/`, then open the public song URL and exercise playback. Do not declare completion from a push or a successful build alone.

## Deployment boundary

- This HQ is the source of truth. Do not use Vercel, Sites, another host, or files under another project's `pages` directory for deployment.
- GitHub Pages is the configured production host; verify the merge SHA's Pages workflow and live bytes before declaring completion.
- Never publish credentials, signed media URLs, caches, virtual environments, raw stems, or unreviewed analysis output.

## Harness maintenance

If another step is missed or a new repeatable failure appears, add the concrete sensor or command to `HARNESS.md` and update these instructions. Do not add blanket permission policies, implicit agents or ceremonial approval gates.
