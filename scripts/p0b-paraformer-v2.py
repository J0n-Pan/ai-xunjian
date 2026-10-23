#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""P0-b: 验证 paraformer-v2 文件转写 —— 词级时间戳是否为真实对齐值。

路径：本地 wav -> Files.upload -> Files.get(url) -> Transcription -> transcription_url -> JSON
"""
import json
import os
import subprocess
import sys
import time

import dashscope
import requests
from dashscope import Files
from dashscope.audio.asr import Transcription


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


def cut_wav(src, dst, start, dur, rate=16000):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", str(start), "-t", str(dur), "-i", src,
         "-vn", "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s16le", dst],
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
    if r.status_code != 200:
        print("async_call failed:", r.status_code, r)
        return None
    task = r.output["task_id"]
    res = Transcription.wait(task)
    elapsed = time.time() - t0
    if res.status_code != 200:
        print("wait failed:", res.status_code, res)
        return None
    out = res.output
    item = ((out.get("results") or [{}])[0] or {}).get("output") or {}
    subs = item.get("results") or []
    turl = subs[0].get("transcription_url") if subs else None
    print(f"  {elapsed:.1f}s  status={out.get('task_status')}  urls={len(subs)}")
    if not turl:
        print("  no transcription_url:", json.dumps(item, ensure_ascii=False)[:400])
        return None
    return requests.get(turl, timeout=60).json()


def show(doc, label):
    print(f"\n### {label}")
    transcripts = doc.get("transcripts") or []
    for t in transcripts:
        sents = t.get("sentences") or []
        print(f"  文本: {(t.get('text') or '')[:80]}")
        print(f"  句数={len(sents)}")
        for s in sents:
            words = s.get("words") or []
            dur = (s["end_time"] - s["begin_time"]) / 1000.0
            print(f"\n  [{s['begin_time']:>6}→{s['end_time']:>6}] {dur:5.2f}s  {s['text']}")
            if words:
                durs = [(w["end_time"] - w["begin_time"]) / 1000.0 for w in words]
                uniq = sorted({round(d, 3) for d in durs})
                print(f"    词数={len(words)} 唯一时长值={uniq[:8]}{' ...' if len(uniq) > 8 else ''}")
                for w in words[:16]:
                    print(f"      {w['begin_time']:>6} {w['end_time']:>6} "
                          f"{(w['end_time']-w['begin_time'])/1000.0:5.2f}s {w['text']!r}")


def main():
    load_env()
    dashscope.api_key = os.environ["DASHSCOPE_API_KEY"]

    src = sys.argv[1] if len(sys.argv) > 1 else r"D:/2/test_cut/为什么孩子要跟你学习.mp4"
    start = float(sys.argv[2]) if len(sys.argv) > 2 else 31
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 12

    wav = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_p2_probe.wav")
    cut_wav(src, wav, start, dur)
    print(f"wav: {os.path.getsize(wav)} bytes  {dur}s")
    fid, url = upload(wav)
    print(f"uploaded file_id={fid}")
    os.remove(wav)

    for label, kw in [
        ("对齐关闭", {}),
        ("对齐开启", {"timestamp_alignment_enabled": True}),
    ]:
        doc = transcribe(url, **kw)
        if doc:
            show(doc, label)


if __name__ == "__main__":
    sys.exit(main())
