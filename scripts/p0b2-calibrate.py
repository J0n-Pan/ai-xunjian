#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P0-b2: paraformer-v2 全片标定 —— 句段粒度、cps 分布、停顿分布。

用法: python scripts/p0b2-calibrate.py <video> <out.json>
"""
import json
import os
import re
import subprocess
import sys
import time

import dashscope
import requests
from dashscope import Files
from dashscope.audio.asr import Transcription

PUNCT = "，。！？；：、,.!?;:"


def load_env():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    p = os.path.join(root, ".env")
    if not os.path.exists(p):
        return
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def to_wav(src, dst):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst],
        check=True,
    )
    return dst


def upload(wav):
    r = Files.upload(file_path=wav, purpose="assistants")
    fid = r.output["uploaded_files"][0]["file_id"]
    return fid, Files.get(fid).output["url"]


def transcribe(url, **kw):
    t0 = time.time()
    r = Transcription.async_call(model="paraformer-v2", file_urls=[url], **kw)
    task = r.output["task_id"]
    res = Transcription.wait(task)
    out = res.output
    item = ((out.get("results") or [{}])[0] or {}).get("output") or {}
    subs = item.get("results") or []
    turl = subs[0].get("transcription_url")
    doc = requests.get(turl, timeout=60).json()
    return doc, time.time() - t0


def main():
    load_env()
    dashscope.api_key = os.environ["DASHSCOPE_API_KEY"]
    src = sys.argv[1]
    dst = sys.argv[2]

    wav = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_cal_full.wav")
    to_wav(src, wav)
    size_mb = os.path.getsize(wav) / 1024 / 1024
    print(f"wav {size_mb:.1f} MB")
    fid, url = upload(wav)
    os.remove(wav)
    print(f"file_id={fid}")

    doc, elapsed = transcribe(
        url, timestamp_alignment_enabled=True, disfluency_removal_enabled=False
    )
    print(f"转写墙钟 {elapsed:.1f}s")

    with open(dst, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)

    sents = []
    for t in doc.get("transcripts") or []:
        sents.extend(t.get("sentences") or [])
    print(f"句数={len(sents)}  音频时长={sents[-1]['end_time']/1000:.1f}s")
    print(f"\n{'起':>7} {'止':>7} {'时长':>6} {'字数':>4} {'cps':>5}  {'块内≥0.25s停顿':>14}  文本")
    for s in sents:
        ws = s["words"]
        dur = (s["end_time"] - s["begin_time"]) / 1000.0
        chars = len(re.sub(rf"[{PUNCT}\s]", "", s["text"]))
        cps = chars / dur if dur else 0
        gaps = []
        for a, b in zip(ws, ws[1:]):
            g = (b["begin_time"] - a["end_time"]) / 1000.0
            if g >= 0.25:
                gaps.append((round(a["end_time"] / 1000, 2), round(g, 2)))
        gap_s = " ".join(f"{t}s+{g}" for t, g in gaps) or "-"
        print(f"{s['begin_time']/1000:7.2f} {s['end_time']/1000:7.2f} {dur:6.2f} "
              f"{chars:4d} {cps:5.2f}  {gap_s:>14}  {s['text'][:32]}")

    all_durs = [(w["end_time"] - w["begin_time"]) / 1000.0
                for s in sents for w in s["words"]]
    all_durs.sort()
    n = len(all_durs)
    if n:
        print(f"\n词时长 n={n} min={all_durs[0]:.2f} p50={all_durs[n//2]:.2f} "
              f"p95={all_durs[int(n*0.95)]:.2f} max={all_durs[-1]:.2f}")
        print(f">0.8s 的词: {sum(1 for d in all_durs if d > 0.8)}")


if __name__ == "__main__":
    sys.exit(main())
