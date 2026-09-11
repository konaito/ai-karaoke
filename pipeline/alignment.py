"""V2: preserve displayed characters while aligning expanded reading aliases."""
from legacy_alignment import align_target, normalize, units_for_words

def align_display(lines, words, readings):
    # Each reading character remembers which displayed character it belongs to.
    normalized=[]; owners=[]
    for line in lines:
        parts=[]; indices=[]; i=0
        while i<len(line):
            alias=next((a for a in sorted(readings,key=len,reverse=True) if line.startswith(a,i)),None)
            display=alias or line[i]
            spoken=normalize(readings[alias] if alias else display)
            parts.append(spoken)
            indices.extend(i+min(len(display)-1,k*len(display)//max(1,len(spoken))) for k in range(len(spoken)))
            i+=len(display)
        normalized.append(''.join(parts));owners.append(indices)
    expanded=[]
    for w in words:
        text=w['word']
        for a in sorted(readings,key=len,reverse=True): text=text.replace(a,readings[a])
        expanded.append(dict(w,word=text))
    payload,metric=align_target(normalized,units_for_words(expanded))
    result=[]
    for text,indices,aligned in zip(lines,owners,payload):
        tokens=[]
        for ci,ch in enumerate(text):
            mapped=[t for owner,t in zip(indices,aligned['tokens']) if owner==ci]
            if mapped:
                start=min(t['start'] for t in mapped);end=max(t['end'] for t in mapped)
                confidence=min(t['confidence'] for t in mapped)
            else:
                start=tokens[-1]['end'] if tokens else aligned['start']
                end=start;confidence=.3
            tokens.append(dict(text=ch,start=start,end=end,confidence=confidence))
        # Punctuation must not extend past the displayed line or move backwards.
        for t in tokens:
            t['start']=max(aligned['start'],min(t['start'],aligned['end']))
            t['end']=max(t['start'],min(t['end'],aligned['end']))
        result.append(dict(start=aligned['start'],end=aligned['end'],tokens=tokens))
    return result,metric
