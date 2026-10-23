# -*- coding: utf-8 -*-
"""P0 单点验证：paraformer-realtime-v2 的词级时间戳能不能支撑「卡壳/语气词」判据。

只做三件事：
  1. 切一段 wav，直接调 Recognition.call(本地文件)；
  2. dump 原始 sentence / words 结构；
  3. 打印「段内停顿表」——相邻词之间 >=0.2s 的空隙，这是新卡壳判据的输入。

用法：
  python scripts/probe-cloud-asr.py <video> <start> <dur> [out.json]
"""
import json
import os
import subprocess
import sys
import time

import dashscope
from dashscope.audio.asr import Recognition, RecognitionCallback


class _CB(RecognitionCallback):
    """同步 call() 只需要一个占位回调；真正的结果从返回值取。"""

    def on_open(self):
        pass

    def on_event(self, result):
        pass

    def on_complete(self):
        pass

    def on_error(self, result):
        print("[callback error]", result, file=sys.stderr)

    def on_close(self):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


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


def cut_wav(src, dst, start, dur):
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(dur),
         "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", dst],
        check=True,
    )


def recognize(path):
    r = Recognition(
        model="paraformer-realtime-v2",
        callback=_CB(),
        format="wav",
        sample_rate=16000,
        disfluency_removal_enabled=False,      # 关键：不能开，否则语气词被抹掉
        timestamp_alignment_enabled=True,      # 关键：默认关，关着的话词时间戳是按词数均分的假值
    )
    # 以下参数新版 SDK 走 **kwargs（见 Recognition.__init__ 的 kwargs 透传）
    r._kwargs.update({
        "language_hints": ["zh"],
        "semantic_punctuation_enabled": False,   # 关键：不要语义重断句
        "punctuation_prediction_enabled": True,
        "max_sentence_silence": 400,
        "multi_threshold_mode_enabled": True,
    })
    t0 = time.time()
    res = r.call(path)
    return res, time.time() - t0


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    video, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    out_path = sys.argv[4] if len(sys.argv) > 4 else ""

    load_env()
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        sys.exit("✗ 没有 DASHSCOPE_API_KEY")
    dashscope.api_key = key

    tmp = os.path.join(HERE, "_probe.wav")
    cut_wav(video, tmp, start, dur)
    print(f"[wav] {start}s +{dur}s -> {tmp} ({os.path.getsize(tmp)/1024:.0f} KB)")

    res, sec = recognize(tmp)
    print(f"[api] status={res.status_code} elapsed={sec:.2f}s request_id={getattr(res, 'request_id', '')}")
    if res.status_code != 200:
        print("[api] message:", res.message)
        sys.exit(2)

    sents = res.get_sentence() or []
    print(f"[api] sentences={len(sents)}")
    print("=" * 70)

    for i, s in enumerate(sents):
        words = s.get("words") or []
        print(f"#{i:02d} [{s.get('begin_time')}→{s.get('end_time')}ms] "
              f"end={s.get('sentence_end')} words={len(words)}")
        print(f"     {s.get('text')}")
        # 段内停顿：相邻词边界空隙
        gaps = []
        for a, b in zip(words, words[1:]):
            g = (b.get("begin_time", 0) - a.get("end_time", 0)) / 1000.0
            if g >= 0.2:
                gaps.append({
                    "at": a.get("end_time", 0) / 1000.0,
                    "gap": round(g, 2),
                    "prev": a.get("text", ""),
                    "next": b.get("text", ""),
                })
        if gaps:
            print("     ⏸ 段内停顿:", " | ".join(
                f"{g['at']:.2f}s {g['gap']}s「{g['prev']}」/「{g['next']}」" for g in gaps))
        # 词时长异常（whisper 式「长词吸收停顿」的反向指标）
        long_w = [(w.get("text"), (w.get("end_time", 0) - w.get("begin_time", 0)) / 1000.0)
                  for w in words if (w.get("end_time", 0) - w.get("begin_time", 0)) >= 800]
        if long_w:
            print("     ⚠ 长词(>=0.8s):", long_w)
        print("-" * 70)

    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"sentences": sents, "elapsed": sec}, f, ensure_ascii=False, indent=1)
        print(f"[dump] {out_path}")

    if os.path.exists(tmp):
        os.remove(tmp)


if __name__ == "__main__":
    main()
