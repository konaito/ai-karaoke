"""Check deployable song assets, timing text and unique catalog routes."""
import json, math
from pathlib import Path
root=Path(__file__).resolve().parents[1]
catalog=json.loads((root/'catalog.json').read_text())
ids=[s['id'] for s in catalog['songs']]
assert len(ids)==len(set(ids)) and catalog['defaultSong'] in ids
for entry in catalog['songs']:
    for asset in [entry['data'],*entry['assets']]:
        path=(root/asset).resolve()
        assert path.is_relative_to(root) and path.is_file(), asset
    song=json.loads((root/entry['data']).read_text())
    for field in ['title','artist']: assert song[field]==entry[field]
    assert all(song[k] in entry['assets'] for k in ['source','cover','alignmentSource'])
    alignment=json.loads((root/song['alignmentSource']).read_text())
    assert len(song['lines'])==len(alignment['lines'])>0
    for line,aligned in zip(song['lines'],alignment['lines']):
        assert line['text']==aligned['text']
        assert ''.join(t['text'] for t in aligned['tokens'])==line['text']
        assert 0<=aligned['start']<aligned['end']<=song['duration']+.05
        assert all(math.isfinite(t[k]) and 0<=t[k]<=song['duration']+.05 for t in aligned['tokens'] for k in ['start','end'])
    print(entry['id'],len(song['lines']),'lines OK')
