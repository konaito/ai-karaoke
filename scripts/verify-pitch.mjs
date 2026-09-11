// Offline signal check. This is self-consistency, not independent human ground truth.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {PitchDetector,ScoreSession} from '../scoring.js';
const [referencePath,vocalsPath,backingPath,outputPath]=process.argv.slice(2);
if(!outputPath) throw new Error('Usage: node scripts/verify-pitch.mjs melody.json vocals.wav accompaniment.mp3 report.json');
const reference=JSON.parse(readFileSync(referencePath));
function analyze(path) {
  const decoded=spawnSync('ffmpeg',['-v','error','-i',path,'-ac','1','-ar','16000','-f','f32le','-'],{maxBuffer:64*1024*1024});
  if(decoded.status!==0)throw new Error(decoded.stderr.toString());
  const data=new Float32Array(decoded.stdout.buffer.slice(decoded.stdout.byteOffset,decoded.stdout.byteOffset+decoded.stdout.byteLength));
  const detector=new PitchDetector(),session=new ScoreSession(reference),window=new Float32Array(2048);
  for(const [time] of reference.frames){
    window.fill(0);const start=Math.round(time*16000)-1024;
    for(let i=0;i<2048;i++)if(start+i>=0&&start+i<data.length)window[i]=data[start+i];
    const detected=detector.detect(window,16000);session.add(time,detected.hz,detected.confidence);
  }
  const {lines,...result}=session.result();return result;
}
const vocals=analyze(vocalsPath),backing=analyze(backingPath);
const report={method:'offline YIN on isolated source stems; not independent accuracy',vocals,backing};
writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n');console.log(report);
if(!vocals.enough||vocals.score<80||vocals.coverage<80)process.exitCode=1;
