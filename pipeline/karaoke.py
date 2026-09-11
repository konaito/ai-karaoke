#!/usr/bin/env python3
"""Known-lyrics karaoke: capture ASR once, replay alignment and build offline."""
import argparse
import copy
import hashlib
import html
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
from legacy_alignment import align_target, units_for_words
from alignment import align_display

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'Systran/faster-whisper-small'
REVISION = '536b0662742c02347bc0e980a01041f333bce120'
OPTIONS = dict(language='ja', task='transcribe', beam_size=5, best_of=5,
               vad_filter=False, word_timestamps=True,
               condition_on_previous_text=False, temperature=0)

def read(path):
    return json.loads(Path(path).read_text())

def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def config(path):
    c = read(path)
    assert c['title'] and c['artist'] and math.isfinite(c['duration']) and c['duration'] > 0
    ids = set()
    for job in c['jobs']:
        assert job['id'] not in ids, 'duplicate job id'
        ids.add(job['id'])
        assert 0 <= job['start'] < job['end'] <= c['duration']
        assert job['lines'] and all(isinstance(t,str) and t.strip() for t in job['lines'])
    return c

def transcribe(args):
    from faster_whisper import WhisperModel
    from huggingface_hub import snapshot_download
    import importlib.metadata
    c = config(args.config)
    out = Path(args.output)
    if out.exists():
        raise ValueError('Output already exists; use a new path to preserve the ASR capture')
    model_path = snapshot_download(MODEL, revision=REVISION)
    model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=4)
    raw = []
    for job in c['jobs']:
        segments, _ = model.transcribe(args.audio, **OPTIONS,
            initial_prompt='。'.join(job.get('promptLines',job['lines']))+'。',
            clip_timestamps=f"{job['start']},{job['end']}")
        rows = []
        for seg in segments:
            rows.append(dict(start=round(seg.start,3), end=round(seg.end,3), text=seg.text.strip(),
                words=[dict(word=w.word, start=round(w.start,3), end=round(w.end,3),
                            probability=w.probability) for w in seg.words or []]))
        raw.append(dict(sectionId=job['id'], segments=rows))
        print(job['id'], ' '.join(s['text'] for s in rows), flush=True)
        write(out.with_suffix('.partial.json'), raw)
    write(out, raw)
    write(out.with_suffix('.provenance.json'), dict(audioSha256=digest(args.audio),
        configSha256=digest(args.config), transcriptsSha256=digest(out),
        model=MODEL, revision=REVISION, device='cpu', computeType='int8', cpuThreads=4,
        options=OPTIONS, python=sys.version, packages={n:importlib.metadata.version(n)
        for n in ['faster-whisper','ctranslate2','huggingface-hub']},
        modelFiles={p.name:digest(p) for p in Path(model_path).iterdir() if p.is_file()}))
    out.with_suffix('.partial.json').unlink()

def align(c, raw):
    assert [r['sectionId'] for r in raw] == [j['id'] for j in c['jobs']], 'ASR jobs mismatch'
    result = dict(version=1, method='known-lyrics-asr-word-timestamps',
                  model='faster-whisper-small', source=c.get('source','track.mp3'), lines=[], metrics=[])
    for job, rec in zip(c['jobs'], raw):
        words = [w for s in rec['segments'] for w in s['words']]
        assert words, f"No words: {job['id']}"
        for w in words:
            assert all(math.isfinite(w[k]) for k in ('start','end'))
            assert 0 <= w['start'] <= w['end'] <= c['duration'] + .05
        if c.get('algorithm') == 'display-readings-v2':
            payload, metrics = align_display(job['lines'], words, c.get('readings', {'AI':'エーアイ'}))
        else:
            payload, metrics = align_target(job['lines'], units_for_words(words))
        result['lines'].extend(dict(sectionId=job['id'],text=t,**p) for t,p in zip(job['lines'],payload))
        result['metrics'].append(dict(sectionId=job['id'],**metrics,segments=len(rec['segments']),words=len(words)))
    return result

def inspect(data, duration):
    issues=[]
    previous=0
    for i,line in enumerate(data['lines']):
        assert ''.join(t['text'] for t in line['tokens']) == line['text'], f'text mismatch: {i}'
        ts=[line['start'],line['end']] + [t[k] for t in line['tokens'] for k in ('start','end')]
        assert all(math.isfinite(t) and 0<=t<=duration+.05 for t in ts), f'invalid time: {i}'
        assert line['start'] < line['end'], f'empty line: {i}'
        if line['start'] < previous: issues.append(dict(line=i,kind='line-overlap'))
        previous=line['end']
        last=line['start']
        for j,t in enumerate(line['tokens']):
            if t['end'] < t['start']: raise ValueError(f'inverted token: {i}:{j}')
            if t['start'] < last-.05 or t['end']>line['end']+.05:
                issues.append(dict(line=i,token=j,kind='token-boundary'))
            if t['confidence']<.6 and t['text'].isalnum():
                issues.append(dict(line=i,token=j,kind='interpolated',text=t['text']))
            last=t['end']
    return issues

def replay(args):
    c=config(args.config)
    provenance_path=Path(args.transcripts).with_suffix('.provenance.json')
    provenance=read(provenance_path) if provenance_path.exists() else {}
    if provenance:
        assert provenance['configSha256']==digest(args.config), 'Config changed since ASR capture'
        assert provenance['transcriptsSha256']==digest(args.transcripts), 'ASR capture hash mismatch'
    data=align(c,read(args.transcripts))
    if args.corrections:
        edits=read(args.corrections)
        for edit in edits:
            line=data['lines'][edit['line']]
            assert line['text']==edit['text'], 'correction text guard mismatch'
            assert edit.get('reason'), 'correction needs a reason'
            # Full token replacement makes every manually adjusted boundary reviewable.
            for key in ['start','end','tokens']:
                if key in edit: line[key]=copy.deepcopy(edit[key])
    issues=inspect(data,c['duration'])
    write(args.output,data)
    write(Path(args.output).with_suffix('.review.json'),dict(
        note='confidence is a mapping heuristic, not ASR probability or timing accuracy',
        issues=issues, metrics=data['metrics']))
    write(Path(args.output).with_suffix('.inputs.json'),dict(
        configSha256=digest(args.config),transcriptsSha256=digest(args.transcripts),
        audioSha256=provenance.get('audioSha256'),
        algorithmSha256={n:digest(Path(__file__).with_name(n)) for n in ['legacy_alignment.py','alignment.py','karaoke.py']},
        correctionsSha256=digest(args.corrections) if args.corrections else None,
        outputSha256=digest(args.output)))
    if args.expect:
        assert data==read(args.expect), 'Replay differs from expected artifact'
    print(f"{len(data['lines'])} lines; {len(issues)} review items",flush=True)

def build(args):
    c=config(args.config); a=read(args.alignment)
    template=Path(args.template).resolve() if args.template else ROOT
    assert [t for j in c['jobs'] for t in j['lines']]==[l['text'] for l in a['lines']]
    inspect(a,c['duration'])
    inputs_path=Path(args.alignment).with_suffix('.inputs.json')
    if inputs_path.exists():
        inputs=read(inputs_path)
        assert inputs['configSha256']==digest(args.config), 'Build config differs from alignment'
        assert inputs['outputSha256']==digest(args.alignment), 'Alignment edited outside replay'
        if inputs.get('audioSha256'): assert inputs['audioSha256']==digest(args.audio), 'Wrong audio for these timestamps'
    actual=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',args.audio]))
    assert abs(actual-c['duration'])<.15, 'audio duration differs from config'
    out=Path(args.output)
    if out.exists(): raise ValueError('Build output exists; choose a new directory')
    out.mkdir(parents=True)
    for name in ['app.js','styles.css','dsp.wasm']:
        shutil.copyfile(template/name,out/name)
    (out/'audio').mkdir(); shutil.copyfile(args.audio,out/'audio/track.mp3')
    shutil.copyfile(args.alignment,out/'alignment.json')
    # A local neutral cover avoids carrying the original song artwork into another song.
    (out/'cover.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="#111827"/><circle cx="900" cy="300" r="500" fill="#172b3a"/></svg>')
    sections=[]; lines=[]
    for ix,job in enumerate(c['jobs']):
        group=[l for l in a['lines'] if l['sectionId']==job['id']]
        sections.append(dict(id=job['id'],index=ix,type=job.get('type','VERSE'),label=job.get('label',job['id']),
                             start=group[0]['start'],end=group[-1]['end'],lines=job['lines']))
        for n,l in enumerate(group):
            lines.append(dict(l,id=f"{job['id']}-{n+1}",section=sections[-1]['type'],
                              sectionLabel=sections[-1]['label'],sectionIndex=ix))
    song=dict(title=c['title'],artist=c['artist'],duration=c['duration'],source='./audio/track.mp3',sections=sections,lines=lines)
    song.update(cover='./cover.svg',coverType='image/svg+xml',alignmentSource='./alignment.json')
    write(out/'song.json',song)
    (out/'song-data.js').write_text('export const SONG = '+json.dumps(song,ensure_ascii=False)+';\nexport const SONG_ID = "preview";\nexport const CATALOG = {songs:[{id:SONG_ID,title:SONG.title,artist:SONG.artist}]};\n')
    page=(template/'index.html').read_text().replace('愛を伝えるだとか',html.escape(c['title'])).replace('konaito',html.escape(c['artist']))
    page=page.replace('cover.jpeg','cover.svg').replace('cover.png','cover.svg').replace('type="image/jpeg"','type="image/svg+xml"').replace('type="image/png"','type="image/svg+xml"')
    page=page.replace('愛を伝える<br />だとか',html.escape(c['title']))
    page=page.replace('231.56',str(c['duration'])).replace('03:52',f"{int(c['duration'])//60:02}:{int(c['duration'])%60:02}")
    page=page.replace('01 / 56',f'01 / {len(lines)}').replace('INTRO · 言葉の前','INTRO')
    (out/'index.html').write_text(page)
    app=(out/'app.js').read_text().replace('"— / 56"',f'"— / {len(lines)}"')
    app=app.replace('./cover.png','./cover.svg').replace('sizes: "1254x1254", type: "image/png"','sizes: "any", type: "image/svg+xml"')
    (out/'app.js').write_text(app)
    write(out/'manifest.webmanifest',dict(name=c['title']+' / KARAOKE',short_name=c['title'],start_url='./',display='standalone',background_color='#05070b',theme_color='#05070b',icons=[dict(src='./cover.svg',sizes='any',type='image/svg+xml',purpose='any')]))
    cover_name='cover.svg'
    if args.cover:
        extension=Path(args.cover).suffix.lower()
        mime={'.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}.get(extension)
        if not mime: raise ValueError('Cover must be WebP, PNG or JPEG')
        cover_name='cover'+extension
        shutil.copyfile(args.cover,out/cover_name)
        for name in ['index.html','app.js','manifest.webmanifest','song-data.js','song.json']:
            path=out/name
            path.write_text(path.read_text().replace('cover.svg',cover_name).replace('image/svg+xml',mime))
        (out/'cover.svg').unlink()
    assets=['./','./index.html','./app.js','./styles.css','./dsp.wasm','./song-data.js','./alignment.json','./audio/track.mp3','./cover.svg','./manifest.webmanifest']
    assets=[a.replace('cover.svg',cover_name) for a in assets]
    key=hashlib.sha256(''.join(digest(out/f[2:]) for f in assets if f!='./').encode()).hexdigest()[:16]
    (out/'sw.js').write_text('const CACHE="karaoke-'+key+'";\nconst ASSETS='+json.dumps(assets)+';\n'+'''
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',e=>{if(e.request.method==='GET')e.respondWith(caches.open(CACHE).then(async c=>(await c.match(e.request,{ignoreSearch:true}))||fetch(e.request)))});
''')
    template_info={'files':{n:digest(template/n) for n in ['app.js','styles.css','dsp.wasm','index.html']}}
    if (template/'.git').exists():
        template_info['commit']=subprocess.check_output(['git','-C',str(template),'rev-parse','HEAD'],text=True).strip()
    write(out/'build.json',dict(template=template_info,audioSha256=digest(args.audio),configSha256=digest(args.config),alignmentSha256=digest(args.alignment),assets={f[2:]:digest(out/f[2:]) for f in assets if f!='./'}))
    print(out.resolve())

def fetch(args):
    out=Path(args.output)
    if out.exists(): raise ValueError('Capture output exists; use a new directory')
    out.mkdir(parents=True)
    subprocess.run([sys.executable,'-m','yt_dlp','--no-playlist','--write-info-json','--write-thumbnail','--convert-thumbnails','webp',
        '-f','bestaudio','-x','--audio-format','mp3','--audio-quality','0',
        '-o',str(out/'track.%(ext)s'),args.url],check=True)
    write(out/'source.json',dict(url=args.url,audioSha256=digest(out/'track.mp3'),
        ffmpeg=subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0]))

def main():
    p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='command',required=True)
    f=sub.add_parser('fetch');f.add_argument('--url',required=True);f.add_argument('--output',required=True);f.set_defaults(run=fetch)
    t=sub.add_parser('transcribe');t.add_argument('--config',required=True);t.add_argument('--audio',required=True);t.add_argument('--output',required=True);t.set_defaults(run=transcribe)
    r=sub.add_parser('replay');r.add_argument('--config',required=True);r.add_argument('--transcripts',required=True);r.add_argument('--output',required=True);r.add_argument('--corrections');r.add_argument('--expect');r.set_defaults(run=replay)
    b=sub.add_parser('build');b.add_argument('--config',required=True);b.add_argument('--alignment',required=True);b.add_argument('--audio',required=True);b.add_argument('--output',required=True);b.add_argument('--cover',help='Local YouTube thumbnail or jacket image');b.add_argument('--template',help='UI source directory; defaults to karaoke/');b.set_defaults(run=build)
    args=p.parse_args();args.run(args)

if __name__=='__main__': main()
