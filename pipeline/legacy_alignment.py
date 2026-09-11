"""Recovered original 2026-09-11 alignment algorithm (unchanged)."""
from difflib import SequenceMatcher
import unicodedata
kanji_digit = dict(zip("0123456789", "零一二三四五六七八九"))

def normalize(text):
    text = unicodedata.normalize('NFKC', text)
    text = text.replace('AI', 'エーアイ').replace('ＡＩ', 'エーアイ')
    text = ''.join(kanji_digit.get(ch, ch) for ch in text)
    return ''.join(ch for ch in text if not ch.isspace() and ch not in '、。！？!?「」『』・,.')

def units_for_words(words):
    units=[]
    for word in words:
        raw=normalize(word['word'])
        if not raw: continue
        start=float(word['start']); end=float(word['end'])
        if end < start: end=start
        duration=max(0.012, end-start)
        for i,ch in enumerate(raw):
            units.append({'char':ch,'start':start+duration*i/len(raw),'end':start+duration*(i+1)/len(raw),'source':'asr'})
    return units

def target_units(lines):
    out=[]
    for li,line in enumerate(lines):
        for ci,ch in enumerate(line):
            if normalize(ch):
                out.append({'char':normalize(ch),'line':li,'char_index':ci})
    return out

def align_target(lines, recognized):
    target=target_units(lines)
    a=''.join(item['char'] for item in target)
    b=''.join(item['char'] for item in recognized)
    matcher=SequenceMatcher(None,a,b,autojunk=False)
    mapped=[None]*len(target)
    confidence=[0.0]*len(target)
    for tag,i1,i2,j1,j2 in matcher.get_opcodes():
        if tag=='equal':
            for i,j in zip(range(i1,i2),range(j1,j2)):
                mapped[i]=(recognized[j]['start'],recognized[j]['end']); confidence[i]=0.96
        elif tag=='replace':
            if j2>j1:
                left=recognized[j1]['start']; right=recognized[j2-1]['end']
                for offset,i in enumerate(range(i1,i2)):
                    mapped[i]=(left+(right-left)*offset/max(1,i2-i1), left+(right-left)*(offset+1)/max(1,i2-i1)); confidence[i]=0.55
        elif tag=='delete':
            left = mapped[i1-1][1] if i1>0 and mapped[i1-1] else (recognized[j1]['start'] if j1<len(recognized) else 0)
            right = recognized[j1]['start'] if j1<len(recognized) else left+0.12
            for offset,i in enumerate(range(i1,i2)):
                mapped[i]=(left+(right-left)*offset/max(1,i2-i1), left+(right-left)*(offset+1)/max(1,i2-i1)); confidence[i]=0.25
    # Fill target characters not represented by normalized sequence (spaces/punctuation) later.
    line_payload=[]
    cursor=0
    for li,line in enumerate(lines):
        chars=[]
        significant=[]
        for ci,ch in enumerate(line):
            if normalize(ch):
                pair=mapped[cursor] if cursor<len(mapped) else None
                chars.append({'text':ch,'start':pair[0] if pair else None,'end':pair[1] if pair else None,'confidence':confidence[cursor] if pair else 0.2})
                if pair: significant.append(chars[-1])
                cursor+=1
            else:
                chars.append({'text':ch,'start':None,'end':None,'confidence':0.3})
        # Interpolate spaces and punctuation between known significant units.
        for ci,item in enumerate(chars):
            if item['start'] is not None: continue
            prev=next((chars[k] for k in range(ci-1,-1,-1) if chars[k]['start'] is not None),None)
            nxt=next((chars[k] for k in range(ci+1,len(chars)) if chars[k]['start'] is not None),None)
            if prev and nxt:
                item['start']=prev['end']; item['end']=nxt['start']
            elif prev:
                item['start']=prev['end']; item['end']=prev['end']+0.04
            elif nxt:
                item['start']=max(0,nxt['start']-0.04); item['end']=nxt['start']
            else:
                item['start']=0; item['end']=0.04
        # Keep punctuation from creating large gaps; line anchors use spoken chars only.
        spoken=significant or chars
        start=min(x['start'] for x in spoken); end=max(x['end'] for x in spoken)
        line_payload.append({'start':round(start,3),'end':round(max(start+0.08,end),3),'tokens':[
            {'text':x['text'],'start':round(max(0,x['start']),3),'end':round(max(x['start']+0.01,x['end']),3),'confidence':round(x['confidence'],2)} for x in chars]})
    # Monotonic cleanup: only use local boundaries; do not smear one line into the next.
    for i in range(len(line_payload)-1):
        next_start=line_payload[i+1]['start']
        if line_payload[i]['end'] >= next_start:
            line_payload[i]['end']=round(max(line_payload[i]['start']+0.08, next_start-0.025),3)
    return line_payload, {'target_chars':len(a),'recognized_chars':len(b),'ratio':round(SequenceMatcher(None,a,b,autojunk=False).ratio(),3)}
