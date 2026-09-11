"""Build a confidence-gated melody from a Demucs vocal stem, never the mix.
Dependencies: librosa==0.11.0, soundfile, numpy. See SCORING.md for reproduction.
"""
import argparse, hashlib, json
from pathlib import Path
import librosa
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument('vocals');parser.add_argument('--source',default='audio/track.mp3');parser.add_argument('--alignment',default='alignment.json');parser.add_argument('--output',default='melody.json')
args=parser.parse_args()
y,sr=librosa.load(args.vocals,sr=16000,mono=True)
f0,voiced,prob=librosa.pyin(y,fmin=65,fmax=800,sr=sr,frame_length=2048,hop_length=160)
rms=librosa.feature.rms(y=y,frame_length=2048,hop_length=160)[0]
lines=json.loads(Path(args.alignment).read_text())['lines']
frames=[];counts=[0]*len(lines)
for tick in range(int(len(y)/sr/.05)):
 t=round(tick*.05,3); i=round(t/.01)
 line=next((n for n,l in enumerate(lines) if l['start']+.06 <= t <= l['end']-.06),None)
 if line is None or i>=len(f0) or not voiced[i] or prob[i]<.65 or rms[i]<.008: continue
 # Reject isolated estimates and abrupt 10ms jumps. Preserve genuine vibrato.
 neighbors=f0[max(0,i-1):i+2]
 if not np.all(np.isfinite(neighbors)) or np.ptp(librosa.hz_to_midi(neighbors))>1.5:continue
 frames.append([t,round(float(librosa.hz_to_midi(f0[i])),2),round(float(prob[i]),3),line]);counts[line]+=1
result={'version':1,'step':.05,'sourceSha256':hashlib.sha256(Path(args.source).read_bytes()).hexdigest(),'method':'demucs-4.0.1-htdemucs-shifts0 + librosa-0.11.0-pyin','confidenceThreshold':.65,'estimated':True,'duration':round(len(y)/sr,3),'frames':frames,'lineCoverageSeconds':[round(n*.05,2) for n in counts]}
Path(args.output).write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n')
print(json.dumps({'frames':len(frames),'seconds':len(frames)*.05,'lines':len(lines),'uncovered':[i for i,n in enumerate(counts) if n==0],'midiRange':[min(x[1] for x in frames),max(x[1] for x in frames)]}))
