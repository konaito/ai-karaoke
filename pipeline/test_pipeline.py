import copy
import json
from pathlib import Path
import tempfile
import unittest
from karaoke import align, config, inspect, read
from alignment import align_display

ROOT=Path(__file__).resolve().parents[1]
class PipelineTests(unittest.TestCase):
    def test_original_capture_reproduces_entire_existing_artifact(self):
        c=config(ROOT/'examples/ai-wo-tsutaeru/song.json')
        result=align(c,read(ROOT/'examples/ai-wo-tsutaeru/transcripts.json'))
        self.assertEqual(result,read(ROOT/'examples/ai-wo-tsutaeru/expected.json'))

    def test_new_song_replays_and_keeps_supplied_display_text(self):
        c=config(ROOT/'examples/jiteisu/song.json')
        result=align(c,read(ROOT/'examples/jiteisu/transcripts.json'))
        self.assertEqual(result,read(ROOT/'examples/jiteisu/alignment.json'))
        self.assertEqual(len(result['lines']),45)
        self.assertTrue(all(i['kind']=='interpolated' for i in inspect(result,c['duration'])))

    def test_ai_reading_maps_back_to_two_displayed_characters(self):
        lines,_=align_display(['「AI」'],[dict(word='AI',start=2.,end=3.)],{'AI':'エーアイ'})
        tokens=lines[0]['tokens']
        self.assertEqual(''.join(t['text'] for t in tokens),'「AI」')
        self.assertEqual((tokens[1]['start'],tokens[2]['end']),(2.,3.))
        self.assertEqual(tokens[-1]['start'],tokens[-1]['end'])

    def test_other_song_capture_cannot_be_paired_silently(self):
        c=config(ROOT/'examples/ai-wo-tsutaeru/song.json')
        raw=read(ROOT/'examples/ai-wo-tsutaeru/transcripts.json')
        raw[0]['sectionId']='wrong-song'
        with self.assertRaises(AssertionError): align(c,raw)

    def test_bad_timestamps_and_text_are_rejected(self):
        base=read(ROOT/'examples/ai-wo-tsutaeru/expected.json')
        for mutation in ['nan','negative','text','reverse']:
            d=copy.deepcopy(base)
            if mutation=='nan': d['lines'][0]['tokens'][0]['start']=float('nan')
            if mutation=='negative': d['lines'][0]['start']=-1
            if mutation=='text': d['lines'][0]['text']='wrong text'
            if mutation=='reverse': d['lines'][0]['tokens'][0]['end']=0
            with self.subTest(mutation=mutation), self.assertRaises((AssertionError,ValueError)):
                inspect(d,231.56)

    def test_interpolation_is_reported(self):
        d=read(ROOT/'examples/ai-wo-tsutaeru/expected.json')
        issues=inspect(d,231.56)
        self.assertTrue(any(i['kind']=='interpolated' for i in issues))

if __name__=='__main__': unittest.main()
