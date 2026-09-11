"""Local-only browser integration fixture; never opens a real microphone.
Serve repository on 127.0.0.1:4191. Melody is a fixed C4 and accompaniment is
truncated to 8 seconds. #silent/#wrong/#denied exercise negative paths.
"""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
import json,subprocess
ROOT=Path(__file__).resolve().parents[1]
clip=Path('/private/tmp/karaoke-score-fixture.mp3')
if not clip.exists():subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(ROOT/'audio/accompaniment.mp3'),'-t','8','-y',str(clip)],check=True)
fixture={'version':1,'step':.05,'sourceSha256':'synthetic-test-only','frames':[[round(i*.05,3),60,.99,i//40]for i in range(160)]}
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
  elif path=='/melody.json':data=json.dumps(fixture).encode();mime='application/json'
  elif path=='/audio/accompaniment.mp3':data=clip.read_bytes();mime='audio/mpeg'
  else:return super().do_GET()
  self.send_response(200);self.send_header('Content-type',mime);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
ThreadingHTTPServer(('127.0.0.1',4191),Handler).serve_forever()
