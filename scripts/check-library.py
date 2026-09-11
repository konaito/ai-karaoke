"""Compatibility entrypoint: song onboarding now requires scoring artifacts."""
from song_harness import validate
for result in validate(): print(result)
