#!/usr/bin/env python3
"""Register a pipeline build as a song without changing the player source."""
import argparse, json, re, shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--id',required=True);p.add_argument('--build',required=True);p.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));a=p.parse_args()
assert re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',a.id), 'Use a lowercase slug'
r=Path(a.root);b=Path(a.build);d=r/'songs'/a.id
catalog=json.loads((r/'catalog.json').read_text())
assert not d.exists() and all(s['id']!=a.id for s in catalog['songs']), 'Song already exists'
s=(b/'song-data.js').read_text();prefix='export const SONG = '
assert s.startswith(prefix)
song=json.loads((b/'song.json').read_text()) if (b/'song.json').exists() else json.loads(s[len(prefix):].strip().removesuffix(';'))
alignment=json.loads((b/'alignment.json').read_text())
assert [l['text'] for l in song['lines']]==[l['text'] for l in alignment['lines']]
cover=next(b.glob('cover.*'));d.mkdir(parents=True)
for source,name in [(b/'audio/track.mp3','track.mp3'),(b/'alignment.json','alignment.json'),(cover,cover.name)]:shutil.copyfile(source,d/name)
base='./songs/'+a.id+'/'
song.update(source=base+'track.mp3',cover=base+cover.name,coverType={'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml'}[cover.suffix],alignmentSource=base+'alignment.json')
(d/'song.json').write_text(json.dumps(song,ensure_ascii=False,indent=2)+'\n')
catalog['songs'].append(dict(id=a.id,title=song['title'],artist=song['artist'],data=base+'song.json',assets=[song['source'],song['cover'],song['alignmentSource']]))
(r/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
print('Registered',a.id)
