# -*- coding: utf-8 -*-
"""P0-b：标定云端 ASR 的「卡壳」替代判据。

背景：paraformer-realtime-v2 返回的 words 时间戳是按词数均分的（每个词 ~0.37s），
「单字时长 > 1.0s」这个 whisper 时代的判据恒不成立。同时它的句段时长是"纯说话时长"，
停顿不计入，所以 cps 会比 whisper 偏高。

本脚本对整条素材分块转写，输出每个句段的：
  s / e / dur / chars / cps / 段内 >=0.2s 停顿数 / 停顿总长

用来回答一个问题：卡壳段在「cps + 段内停顿」这两个维度上，是否仍是离群值。

用法：python scripts/p0-calibrate.py <video> [out.json]
"""
import json
import os
import subprocess
import sys
import time

import dashscope
from dashscope.audio.asr import Recognition, RecognitionCallback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHUNK = 55.0          # 单次识别块长（秒）
PUNCT = "，。！？、；：,.!?;: "


def load_env():
    p = os.path.join(ROOT, ".env")
    if not os.path.exists(p):
        return
    with open(p, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


class _CB(RecognitionCallback):
    def on_open(self): pass
    def on_event(self, r): pass
    def on_complete(self): pass
    def on_error(self, r): print("[cb]", r, file=sys.stderr)
    def on_close(self): pass


def dur_of(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def cut_wav(src, dst, start, dur):
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(dur),
         "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", dst],
        check=True)


def silence_table(src, noise="-32dB", d=0.15):
    """全片停顿表：[{s,e,dur}]，秒。"""
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", src, "-af",
         f"silencedetect=noise={noise}:d={d}", "-f", "null", "-"],
        capture_output=True, text=True)
    out, cur = [], None
    for line in r.stderr.splitlines():
        if "silence_start:" in line:
            cur = float(line.split("silence_start:")[1].strip().split()[0])
        elif "silence_end:" in line and cur is not None:
            e = float(line.split("silence_end:")[1].split("|")[0].strip())
            out.append({"s": round(cur, 3), "e": round(e, 3), "dur": round(e - cur, 3)})
            cur = None
    return out


def recognize(path, offset):
    r = Recognition(model="paraformer-realtime-v2", callback=_CB(), format="wav",
                    sample_rate=16000, disfluency_removal_enabled=False)
    r._kwargs.update({
        "language_hints": ["zh"],
        "semantic_punctuation_enabled": False,
        "punctuation_prediction_enabled": True,
        "max_sentence_silence": 400,
        "multi_threshold_mode_enabled": True,
    })
    res = r.call(path)
    if res.status_code != 200:
        raise RuntimeError(f"{res.status_code} {res.message}")
    out = []
    for s in res.get_sentence() or []:
        out.append({
            "s": round(offset + s["begin_time"] / 1000.0, 3),
            "e": round(offset + s["end_time"] / 1000.0, 3),
            "z": s.get("text") or "",
            "nw": len(s.get("words") or []),
        })
    return out


def main():
    video = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else ""
    load_env()
    dashscope.api_key = os.environ["DASHSCOPE_API_KEY"]

    total = dur_of(video)
    print(f"[video] {os.path.basename(video)}  {total:.2f}s")

    tmp = os.path.join(HERE, "_cal.wav")
    segs, t0 = [], time.time()
    start = 0.0
    while start < total - 0.2:
        d = min(CHUNK, total - start)
        cut_wav(video, tmp, start, d)
        part = recognize(tmp, start)
        segs.extend(part)
        print(f"  [{start:6.1f}s +{d:5.1f}s] {len(part)} 句")
        start += d
    elapsed = time.time() - t0
    if os.path.exists(tmp):
        os.remove(tmp)

    pauses = silence_table(video)

    for s in segs:
        text = "".join(ch for ch in s["z"] if ch not in PUNCT)
        s["chars"] = len(text)
        s["dur"] = round(s["e"] - s["s"], 3)
        s["cps"] = round(s["chars"] / s["dur"], 2) if s["dur"] > 0 else 0
        inside = [p for p in pauses if p["s"] >= s["s"] and p["e"] <= s["e"] and p["dur"] >= 0.2]
        s["pauseN"] = len(inside)
        s["pauseSum"] = round(sum(p["dur"] for p in inside), 2)
        s["pauseMax"] = round(max([p["dur"] for p in inside], default=0), 2)

    print("\n  #   区间            字数  时长   cps  停顿n/合计/最大   文本")
    for i, s in enumerate(segs):
        print(f"{i:>3}  {s['s']:>6.2f}-{s['e']:>6.2f}  {s['chars']:>4}  {s['dur']:>5.2f}  "
              f"{s['cps']:>4.2f}   {s['pauseN']:>2}/{s['pauseSum']:>4.1f}/{s['pauseMax']:>3.1f}   "
              f"{s['z'][:34]}")

    cps = sorted(s["cps"] for s in segs if s["chars"] >= 4)
    if cps:
        mid = cps[len(cps) // 2]
        print(f"\n[统计] 句数={len(segs)} cps: min={cps[0]} p25={cps[len(cps)//4]} "
              f"median={mid} p75={cps[3*len(cps)//4]} max={cps[-1]}")
        print(f"[统计] cps<3.0 的句: {sum(1 for x in cps if x < 3.0)} / {len(cps)}")
        print(f"[统计] cps<3.5 的句: {sum(1 for x in cps if x < 3.5)} / {len(cps)}")
    print(f"[统计] 识别耗时 {elapsed:.1f}s（实时率 {total/elapsed:.1f}x）")

    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"video": video, "total": total, "segs": segs, "pauses": pauses,
                       "elapsed": elapsed}, f, ensure_ascii=False, indent=1)
        print(f"[dump] {out_path}")


if __name__ == "__main__":
    main()
