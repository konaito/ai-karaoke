#!/usr/bin/env python3
"""Generate reference, backing and a hash-bound provenance receipt together."""
import argparse, hashlib, importlib.metadata, json, os, platform, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--audio',required=True);p.add_argument('--alignment',required=True);p.add_argument('--output',required=True)
    a=p.parse_args();audio=Path(a.audio).resolve();alignment=Path(a.alignment).resolve();out=Path(a.output).resolve()
    if out.exists(): p.error('Output exists; choose a new capture directory')
    versions={n:importlib.metadata.version(n) for n in ['demucs','torch','torchaudio','librosa','soundfile','numpy']}
    expected={'demucs':'4.0.1','torch':'2.5.1','torchaudio':'2.5.1','librosa':'0.11.0'}
    if any(versions[n].split('+')[0]!=v for n,v in expected.items()):p.error('Use the locked pipeline/scoring environment')
    out.mkdir(parents=True)
    env=dict(os.environ,OMP_NUM_THREADS='4',MKL_NUM_THREADS='4')
    commands=[]
    def run(cmd):
        commands.append([str(x) for x in cmd]);subprocess.run(cmd,env=env,check=True)
    run([sys.executable,'-m','demucs','-n','htdemucs','--two-stems','vocals','--shifts','0','--device','cpu','-j','4','-o',str(out/'stems'),str(audio)])
    stems=out/'stems'/'htdemucs'/audio.stem
    run([sys.executable,str(ROOT/'scripts/build-melody.py'),str(stems/'vocals.wav'),'--source',str(audio),'--alignment',str(alignment),'--output',str(out/'melody.json')])
    run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(stems/'no_vocals.wav'),'-codec:a','libmp3lame','-b:a','192k',str(out/'accompaniment.mp3')])
    reference=json.loads((out/'melody.json').read_text())
    duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(out/'accompaniment.mp3')]))
    if abs(duration-reference['duration'])>.15:raise ValueError('Backing/reference duration mismatch')
    receipt={'version':1,'sourceSha256':sha(audio),'alignmentSha256':sha(alignment),
      'melodySha256':sha(out/'melody.json'),'accompanimentSha256':sha(out/'accompaniment.mp3'),
      'vocalsSha256':sha(stems/'vocals.wav'),'backingWavSha256':sha(stems/'no_vocals.wav'),
      'method':reference['method'],'packages':versions,'python':sys.version,'platform':platform.platform(),
      'model':'htdemucs','shifts':0,'device':'cpu','threads':4,
      'modelWeights':{f.name:sha(f) for f in Path.home().joinpath('.cache/torch/hub/checkpoints').glob('955717e8-*.th')},
      'ffmpeg':subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0],
      'generatorSha256':sha(ROOT/'scripts/build-melody.py'),
      'expectedSeconds':round(len(reference['frames'])*reference['step'],2),
      'insufficientLines':[i for i,t in enumerate(reference['lineCoverageSeconds']) if t<.3]}
    if not receipt['modelWeights']:raise ValueError('Model weight receipt missing')
    (out/'scoring-provenance.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
    (out/'commands.json').write_text(json.dumps(commands,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'output':str(out),'expectedSeconds':receipt['expectedSeconds'],'insufficientLines':receipt['insufficientLines']}))
if __name__=='__main__':main()
