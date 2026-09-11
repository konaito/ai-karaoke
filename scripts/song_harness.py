"""Fail-closed asset, scoring and release checks for song onboarding."""
import argparse, hashlib, json, math, re, shutil, subprocess, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
LEGACY_IDS={'ai-wo-tsutaeru'}
def load(p): return json.loads(Path(p).read_text())
def write(p,d): Path(p).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def require(ok,message):
    if not ok: raise ValueError(message)
def local(root,ref):
    p=(root/ref).resolve();require(p.is_relative_to(root.resolve()) and p.is_file(),f'Missing or unsafe asset: {ref}');return p

def scoring_packet(audio,alignment,melody,backing,receipt,song_id=None,media=False):
    ref=load(melody);proof=load(receipt);lines=load(alignment)['lines']
    for key,path in [('sourceSha256',audio),('alignmentSha256',alignment),('melodySha256',melody),('accompanimentSha256',backing)]:
        require(proof.get(key)==sha(path),f'Scoring input/output mismatch: {key}')
    require(proof.get('kind','generated')=='generated' or song_id in LEGACY_IDS,'Legacy scoring receipts are restricted to the original song')
    if proof.get('kind')!='legacy-verified':
        require(bool(proof.get('modelWeights')) and bool(proof.get('generatorSha256')) and bool(proof.get('packages')), 'Missing scoring generation provenance')
    require(ref.get('sourceSha256')==sha(audio),'Melody belongs to another audio file')
    require(ref.get('version')==1 and .02<=ref.get('step',0)<=.1,'Invalid melody version/step')
    require(ref.get('estimated') is True,'Label auto-extracted melody as estimated')
    counts=[0]*len(lines);previous=-1
    for f in ref.get('frames',[]):
        require(len(f)==4 and all(isinstance(v,(int,float)) and math.isfinite(v) for v in f),'Nonfinite melody frame')
        t,midi,confidence,index=f
        require(isinstance(index,int) and 0<=index<len(lines),'Melody line index outside lyrics')
        require(t>previous and abs(t/ref['step']-round(t/ref['step']))<.001,'Melody time order/grid invalid')
        require(lines[index]['start']<=t<=lines[index]['end'] and 30<=midi<=100 and .6<=confidence<=1,'Melody outside lyric/pitch/confidence bounds')
        counts[index]+=1;previous=t
    coverage=[round(n*ref['step'],2) for n in counts]
    require(coverage==ref.get('lineCoverageSeconds'),'Coverage report is stale')
    require(sum(coverage)>=5,'Less than five seconds of trustworthy scoring reference')
    require(abs(proof.get('expectedSeconds',-1)-sum(coverage))<.02,'Scoring coverage receipt mismatch')
    insufficient=[i for i,t in enumerate(coverage) if t<.3]
    require(proof.get('insufficientLines')==insufficient,'Uncovered/short phrases must be explicitly reported')
    if media:
        def duration(p):return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(p)]))
        require(abs(duration(audio)-duration(backing))<.15,'Backing duration differs from audio')
        require(abs(duration(audio)-ref['duration'])<.15,'Reference duration differs from audio')
    return {'seconds':round(sum(coverage),2),'sufficientLines':len(lines)-len(insufficient),'totalLines':len(lines),'insufficientLines':insufficient}

def validate(root=ROOT,media=False):
    root=Path(root).resolve();catalog=load(root/'catalog.json');ids=[e['id'] for e in catalog['songs']]
    require(len(ids)==len(set(ids)) and catalog['defaultSong'] in ids,'Catalog ids/default invalid')
    summary=[]
    for e in catalog['songs']:
        song=load(local(root,e['data']))
        for key in ['title','artist']:require(song[key]==e[key],f'Catalog metadata mismatch: {key}')
        for field in ['source','cover','alignmentSource','melodySource','accompanimentSource','scoringProvenanceSource']:
            require(bool(song.get(field)),f'{e["id"]}: missing {field}; song onboarding is incomplete')
            require(song[field] in e['assets'],f'Asset missing from offline cache catalog: {field}')
            local(root,song[field])
        for asset in e['assets']:local(root,asset)
        cover=local(root,song['cover']).read_bytes()
        require(cover.startswith(b'\x89PNG') or cover.startswith(b'\xff\xd8\xff') or (cover.startswith(b'RIFF') and cover[8:12]==b'WEBP'),'Use the actual raster jacket, not an SVG placeholder')
        alignment=load(local(root,song['alignmentSource']));require(len(song['lines'])==len(alignment['lines'])>0,'Lyric count mismatch')
        for line,a in zip(song['lines'],alignment['lines']):
            require(line['text']==a['text']==''.join(t['text'] for t in a['tokens']),'Display/timing characters mismatch')
            require(0<=a['start']<a['end']<=song['duration']+.05,'Line time outside audio')
            for token in a['tokens']:
                require(all(math.isfinite(token[k]) for k in ['start','end']) and 0<=token['start']<=token['end']<=song['duration']+.05,'Invalid lyric token time')
        report=scoring_packet(local(root,song['source']),local(root,song['alignmentSource']),local(root,song['melodySource']),local(root,song['accompanimentSource']),local(root,song['scoringProvenanceSource']),e['id'],media)
        summary.append(dict(id=e['id'],**report))
    return summary

def attach(root,song_id,directory):
    root=Path(root).resolve();catalog=load(root/'catalog.json');entry=next(e for e in catalog['songs'] if e['id']==song_id);path=local(root,entry['data']);song=load(path);directory=Path(directory)
    scoring_packet(local(root,song['source']),local(root,song['alignmentSource']),directory/'melody.json',directory/'accompaniment.mp3',directory/'scoring-provenance.json',song_id,True)
    fields={'melodySource':'melody.json','accompanimentSource':'accompaniment.mp3','scoringProvenanceSource':'scoring-provenance.json'}
    for field,name in fields.items():
        target=path.parent/name
        require(not target.exists(),f'{target} already exists; preserve existing captures')
    for field,name in fields.items():
        target=path.parent/name;shutil.copyfile(directory/name,target)
        song[field]='./'+str(target.relative_to(root));entry['assets'].append(song[field])
    write(path,song);write(root/'catalog.json',catalog)

def bump(root,version):
    require(re.fullmatch(r'\d+(?:\.\d+)*',version),'Version must be numeric')
    for name in ['app.js','index.html','song-data.js','scoring-ui.js','sw.js']:
        p=root/name;s=p.read_text();s=re.sub(r'\?v=\d+(?:\.\d+)*','?v='+version,s);s=re.sub(r'ai-karaoke-v\d+(?:\.\d+)*','ai-karaoke-v'+version,s);p.write_text(s)
    write(root/'release.json',{'version':version})

def check_release(root):
    v=load(root/'release.json')['version'];files=['app.js','index.html','song-data.js','scoring-ui.js','sw.js']
    for name in files:
        text=(root/name).read_text();found=re.findall(r'\?v=(\d+(?:\.\d+)*)',text)
        require(found and set(found)=={v},f'Mixed cache versions: {name}')
    require(f'ai-karaoke-v{v}' in (root/'sw.js').read_text(),'SW cache version mismatch')
    for name in ['app.js','scoring-ui.js']:
        for path in re.findall(r'from\s+[\"\'](\./[^\"\']+)',(root/name).read_text()):
            require(path.endswith('?v='+v),f'Unversioned module import: {path}')
    return v

def published(root,base,song_id):
    v=check_release(root);catalog=load(root/'catalog.json');entry=next(e for e in catalog['songs'] if e['id']==song_id)
    paths=['catalog.json','app.js','song-data.js','scoring-ui.js','scoring.js','sw.js',entry['data'],*entry['assets']]
    for path in paths:
        request=urllib.request.Request(base.rstrip('/')+'/'+path.removeprefix('./')+'?v='+v,headers={'Cache-Control':'no-cache'})
        with urllib.request.urlopen(request,timeout=60) as r:data=r.read()
        require(hashlib.sha256(data).hexdigest()==sha(local(root,path)),f'Published bytes differ: {path}')
    return {'song':song_id,'version':v,'assetsVerified':len(paths),'base':base}

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT);sub=p.add_subparsers(dest='action',required=True)
    q=sub.add_parser('check');q.add_argument('--media',action='store_true')
    q=sub.add_parser('attach-scoring');q.add_argument('--song',required=True);q.add_argument('--from-dir',required=True)
    q=sub.add_parser('bump');q.add_argument('version')
    q=sub.add_parser('verify-published');q.add_argument('--song',required=True);q.add_argument('--base',default='https://konaito.github.io/ai-karaoke/')
    a=p.parse_args()
    if a.action=='check':print(json.dumps({'songs':validate(a.root,a.media),'release':check_release(a.root)},ensure_ascii=False,indent=2))
    elif a.action=='attach-scoring':attach(a.root,a.song,a.from_dir)
    elif a.action=='bump':bump(a.root,a.version)
    elif a.action=='verify-published':print(json.dumps(published(a.root,a.base,a.song),ensure_ascii=False))
if __name__=='__main__':main()
