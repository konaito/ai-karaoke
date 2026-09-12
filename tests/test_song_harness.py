import importlib.util, json, shutil, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('harness',ROOT/'scripts/song_harness.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class OnboardingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        for name in ['songs','audio']:shutil.copytree(ROOT/name,self.root/name)
        for name in ['catalog.json','melody.json','release.json','app.js','index.html','song-data.js','scoring-ui.js','sw.js']:shutil.copyfile(ROOT/name,self.root/name)
    def tearDown(self):self.tmp.cleanup()
    def song(self):return self.root/'songs/jiteisu/song.json'
    def mutate(self,path,fn):
        d=h.load(path);fn(d);h.write(path,d)
    def test_complete_library_and_versions_pass(self):
        self.assertEqual(len(h.validate(self.root)),3);h.check_release(self.root)
    def test_omitted_scoring_is_not_a_complete_song(self):
        self.mutate(self.song(),lambda d:d.pop('melodySource'))
        with self.assertRaisesRegex(ValueError,'missing melodySource'):h.validate(self.root)
    def test_placeholder_cover_fails(self):
        (self.root/'songs/jiteisu/cover.webp').write_text('<svg/>')
        with self.assertRaisesRegex(ValueError,'actual raster'):h.validate(self.root)
    def test_other_song_reference_fails(self):
        shutil.copyfile(self.root/'melody.json',self.root/'songs/jiteisu/melody.json')
        with self.assertRaisesRegex(ValueError,'mismatch'):h.validate(self.root)
    def test_unlisted_cache_asset_fails(self):
        self.mutate(self.root/'catalog.json',lambda d:d['songs'][1]['assets'].remove('./songs/jiteisu/accompaniment.mp3'))
        with self.assertRaisesRegex(ValueError,'offline cache'):h.validate(self.root)
    def test_stale_audio_and_coverage_fail(self):
        (self.root/'songs/jiteisu/track.mp3').write_bytes(b'wrong audio')
        with self.assertRaisesRegex(ValueError,'sourceSha256'):h.validate(self.root)
    def test_hidden_coverage_warning_fails(self):
        path=self.root/'songs/jiteisu/scoring-provenance.json'
        self.mutate(path,lambda d:d.update(insufficientLines=[]))
        with self.assertRaisesRegex(ValueError,'explicitly reported'):h.validate(self.root)
    def test_stale_display_version_fails(self):
        p=self.root/'index.html';p.write_text(p.read_text().replace('STAGE / v'+str(h.load(self.root/'release.json')['version']),'STAGE / v0'))
        with self.assertRaisesRegex(ValueError,'Displayed version'):h.check_release(self.root)
    def test_stale_module_version_fails(self):
        p=self.root/'app.js';p.write_text(p.read_text().replace('?v='+str(h.load(self.root/'release.json')['version']),'?v=0',1))
        with self.assertRaisesRegex(ValueError,'Mixed cache'):h.check_release(self.root)
if __name__=='__main__':unittest.main()
