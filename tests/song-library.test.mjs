import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ScoreSession,midiToFrequency} from '../scoring.js';
const root=new URL('../',import.meta.url);
const read=path=>JSON.parse(readFileSync(new URL(path,root)));
for(const entry of read('catalog.json').songs){
  test(`${entry.id}: registered scoring handles matching notes, wrong notes and silence`,()=>{
    const song=read(entry.data),reference=read(song.melodySource);
    const exact=new ScoreSession(reference),wrong=new ScoreSession(reference),silent=new ScoreSession(reference);
    for(const [t,midi] of reference.frames){exact.add(t,midiToFrequency(midi));wrong.add(t,midiToFrequency(midi+3));}
    assert.equal(exact.result().score,100);assert.equal(wrong.result().score,0);assert.equal(silent.result().score,null);
    assert.equal(reference.lineCoverageSeconds.length,song.lines.length);
  });
}
