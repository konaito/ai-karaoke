"""Local-only browser integration fixture; never opens a real microphone.
Serve repository on 127.0.0.1:4191. Melody is a fixed C4 and accompaniment is
truncated to 8 seconds. #silent/#wrong/#denied exercise negative paths.
"""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
import json,subprocess,argparse,tempfile
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--song',default='ai-wo-tsutaeru');parser.add_argument('--port',type=int,default=4191);args=parser.parse_args()
catalog=json.loads((ROOT/'catalog.json').read_text());entry=next(e for e in catalog['songs'] if e['id']==args.song);catalog['defaultSong']=args.song
song=json.loads((ROOT/entry['data']).read_text());song['duration']=8
song['lines']=song['lines'][:4]
for i,line in enumerate(song['lines']):line.update(start=i*2,end=(i+1)*2,tokens=[dict(text=c,start=i*2,end=(i+1)*2,confidence=.99) for c in line['text']])
song['sections']=[dict(id='test',index=0,type='VERSE',label='合成テスト',start=0,end=8,lines=[l['text'] for l in song['lines']])]
for line in song['lines']:line.update(sectionId='test',sectionIndex=0,section='VERSE',sectionLabel='合成テスト')
fixture_dir=tempfile.TemporaryDirectory(prefix='karaoke-score-fixture-');clip=Path(fixture_dir.name)/'track.mp3'
if not clip.exists():subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(ROOT/song['accompanimentSource']),'-t','8','-y',str(clip)],check=True)
fixture={'version':1,'step':.05,'sourceSha256':'synthetic-test-only','lineCoverageSeconds':[2,2,2,2],'frames':[[round(i*.05,3),60,.99,i//40]for i in range(160)]}
patch='''<script>
const RealContext=window.AudioContext;
let testContexts=[];
Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
 if(location.hash==='#denied') throw new DOMException('Test permission denial','NotAllowedError');
 const c=new RealContext();await c.resume();testContexts.push(c);
 const o=c.createOscillator(), g=c.createGain(), d=c.createMediaStreamDestination();
 o.frequency.value=location.hash==='#wrong'?311.12698:261.625565;
 g.gain.value=location.hash==='#silent'?0:.2;
 o.connect(g).connect(d);o.start();
 d.stream.getAudioTracks()[0].addEventListener('ended',()=>c.close());
 return d.stream;
}});
window.addEventListener('pagehide',()=>testContexts.forEach(c=>c.close()));
</script>'''
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**k):super().__init__(*a,directory=str(ROOT),**k)
 def do_GET(self):
  path=self.path.split('?')[0]
  if path=='/sw.js':self.send_error(404);return
  if path=='/':data=(ROOT/'index.html').read_text().replace('<head>','<head>'+patch).encode();mime='text/html'
  elif path=='/catalog.json':data=json.dumps(catalog).encode();mime='application/json'
  elif path=='/'+entry['data'].removeprefix('./'):data=json.dumps(song).encode();mime='application/json'
  elif path=='/'+song['alignmentSource'].removeprefix('./'):data=json.dumps({'lines':song['lines']}).encode();mime='application/json'
  elif path=='/'+song['melodySource'].removeprefix('./'):data=json.dumps(fixture).encode();mime='application/json'
  elif path in ['/'+song[k].removeprefix('./') for k in ['source','accompanimentSource']]:data=clip.read_bytes();mime='audio/mpeg'
  else:return super().do_GET()
  self.send_response(200);self.send_header('Content-type',mime);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
