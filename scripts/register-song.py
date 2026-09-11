#!/usr/bin/env python3
"""Register a pipeline build as a song without changing the player source."""
import argparse, json, re, shutil
from pathlib import Path
from song_harness import scoring_packet, require
p=argparse.ArgumentParser();p.add_argument('--id',required=True);p.add_argument('--build',required=True);p.add_argument('--scoring',required=True,help='prepare-scoring.py output directory');p.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));a=p.parse_args()
assert re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',a.id), 'Use a lowercase slug'
r=Path(a.root);b=Path(a.build);d=r/'songs'/a.id
catalog=json.loads((r/'catalog.json').read_text())
assert not d.exists() and all(s['id']!=a.id for s in catalog['songs']), 'Song already exists'
s=(b/'song-data.js').read_text();prefix='export const SONG = '
assert s.startswith(prefix)
song=json.loads((b/'song.json').read_text()) if (b/'song.json').exists() else json.loads(s[len(prefix):].strip().removesuffix(';'))
alignment=json.loads((b/'alignment.json').read_text())
assert [l['text'] for l in song['lines']]==[l['text'] for l in alignment['lines']]
covers=list(b.glob('cover.*'));require(len(covers)==1,'Build must contain exactly one jacket');cover=covers[0]
image=cover.read_bytes();require(image.startswith(b'\x89PNG') or image.startswith(b'\xff\xd8\xff') or (image.startswith(b'RIFF') and image[8:12]==b'WEBP'),'Use the actual raster jacket')
sc=Path(a.scoring)
scoring_packet(b/'audio/track.mp3',b/'alignment.json',sc/'melody.json',sc/'accompaniment.mp3',sc/'scoring-provenance.json',media=True)
d.mkdir(parents=True)
for source,name in [(b/'audio/track.mp3','track.mp3'),(b/'alignment.json','alignment.json'),(cover,cover.name)]:shutil.copyfile(source,d/name)
base='./songs/'+a.id+'/'
song.update(source=base+'track.mp3',cover=base+cover.name,coverType={'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml'}[cover.suffix],alignmentSource=base+'alignment.json')
for field,name in {'melodySource':'melody.json','accompanimentSource':'accompaniment.mp3','scoringProvenanceSource':'scoring-provenance.json'}.items():
 shutil.copyfile(sc/name,d/name);song[field]=base+name
(d/'song.json').write_text(json.dumps(song,ensure_ascii=False,indent=2)+'\n')
catalog['songs'].append(dict(id=a.id,title=song['title'],artist=song['artist'],data=base+'song.json',assets=[song['source'],song['cover'],song['alignmentSource'],song['melodySource'],song['accompanimentSource'],song['scoringProvenanceSource']]))
(r/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
print('Registered',a.id)
