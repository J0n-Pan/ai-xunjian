# -*- coding: utf-8 -*-
"""云端转写：paraformer-v2 文件转写 → 统一 IR（与 asr_and_caps.py 的 raw-segs 同构）。

用法: python asr_cloud.py <音频.wav> <句段输出.json>

为什么是「文件转写」而不是「实时识别」：
  实时接口 paraformer-realtime-v2 的词级时间戳是**均分值**（实测 21 词 / 7.84s，
  每词恒为 0.375s，timestamp_alignment_enabled 也无效），卡壳判据的「单字异常长」
  恒不成立、句段 cps 也没有区分度（卡壳段 5.30 vs 正常段 5.51~5.58）。
  文件接口 paraformer-v2 开 timestamp_alignment_enabled=True 后给出的是**真实对齐值**
  （实测 c1：字时长 0.06~0.73s，p50=0.16、p95=0.36，字间有真实停顿），
  句段粒度 14 段/73s，与 whisper 的 13 段相当。

本地文件怎么上云：走 DashScope 的 Files 接口（purpose=assistants）拿一个带签名的
OSS URL（有效期约 2.6 小时），无需用户自备 OSS 桶与 AccessKey。

输出 IR: [{ "s": 起, "e": 止, "z": 文本, "w": [[起, 止, 词], ...] }, ...]
"""
import json
import os
import sys
import time

import dashscope
import requests
from dashscope import Files
from dashscope.audio.asr import Transcription

MODEL = os.environ.get("XUNJIAN_ASR_CLOUD_MODEL", "paraformer-v2")
# paraformer-v2 文件转写：¥0.00008/秒（¥0.288/小时）。仅用于账单打印，不参与决策。
PRICE_PER_SEC = float(os.environ.get("XUNJIAN_ASR_PRICE", "0.00008"))


def die(msg, code=2):
    sys.stderr.write("✗ asr_cloud: %s\n" % msg)
    sys.exit(code)


def pick_key():
    k = (os.environ.get("DASHSCOPE_API_KEY") or "").strip()
    if not k:
        die("未设置 DASHSCOPE_API_KEY。\n"
            "  申请地址: https://bailian.console.aliyun.com/  (需阿里云实名认证)\n"
            "  配置方法: 在项目根目录 .env 里写 DASHSCOPE_API_KEY=sk-xxx")
    return k


def upload(wav):
    """上传本地音频，返回 (file_id, 带签名的可访问 URL)。"""
    try:
        r = Files.upload(file_path=wav, purpose="assistants")
    except Exception as e:
        die("上传失败: %s: %s" % (type(e).__name__, e))
    if getattr(r, "status_code", 0) != 200:
        die("上传失败 HTTP %s: %s" % (getattr(r, "status_code", "?"),
                                    json.dumps(getattr(r, "output", None), ensure_ascii=False)[:300]))
    up = (r.output or {}).get("uploaded_files") or []
    if not up:
        die("上传返回空: %s" % json.dumps(r.output, ensure_ascii=False)[:300])
    fid = up[0]["file_id"]
    meta = Files.get(fid)
    url = ((getattr(meta, "output", None) or {}).get("url") or "").strip()
    if not url:
        die("拿不到文件 URL: %s" % json.dumps(getattr(meta, "output", None), ensure_ascii=False)[:300])
    return fid, url


def transcribe(url, retries=3):
    """提交异步任务并轮询。失败重试，**绝不静默降级**——少一段转写会让下游多剪/漏剪而不自知。"""
    last = ""
    for attempt in range(1, retries + 1):
        try:
            r = Transcription.async_call(
                model=MODEL,
                file_urls=[url],
                # 真实词级时间戳的总开关。实测关闭时每个字恒为 0.181/0.182s（均分）。
                timestamp_alignment_enabled=True,
                # 必须 False：开了会把「嗯/呃」这类语气词当不流畅成分抹掉，语气词剪点直接失效。
                disfluency_removal_enabled=False,
                punctuation_prediction_enabled=True,
            )
            if getattr(r, "status_code", 0) != 200:
                last = "submit HTTP %s: %s" % (getattr(r, "status_code", "?"),
                                               json.dumps(getattr(r, "output", None), ensure_ascii=False)[:200])
                time.sleep(2 * attempt)
                continue
            task = (r.output or {}).get("task_id")
            if not task:
                last = "无 task_id"
                time.sleep(2 * attempt)
                continue
            res = Transcription.wait(task)
            if getattr(res, "status_code", 0) != 200:
                last = "wait HTTP %s" % getattr(res, "status_code", "?")
                time.sleep(2 * attempt)
                continue
            out = res.output or {}
            if (out.get("task_status") or "").upper() not in ("SUCCEEDED", "SUCCESS"):
                last = "task_status=%s" % out.get("task_status")
                time.sleep(3 * attempt)
                continue
            return out
        except Exception as e:                      # 网络/限流/协议错误
            last = "%s: %s" % (type(e).__name__, e)
            time.sleep(2 * attempt)
    die("转写失败（已重试 %d 次）: %s" % (retries, last))


def fetch_doc(out):
    """从任务输出里取 transcription_url 并下载结果 JSON。"""
    item = ((out.get("results") or [{}])[0] or {}).get("output") or {}
    subs = item.get("results") or []
    if not subs:
        die("任务结果为空: %s" % json.dumps(item, ensure_ascii=False)[:400])
    sub = subs[0]
    st = (sub.get("subtask_status") or "").upper()
    if st and st not in ("SUCCEEDED", "SUCCESS"):
        die("子任务失败 %s: %s" % (st, sub.get("message") or ""))
    turl = sub.get("transcription_url")
    if not turl:
        die("无 transcription_url: %s" % json.dumps(sub, ensure_ascii=False)[:400])
    for attempt in range(1, 4):
        try:
            resp = requests.get(turl, timeout=60)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == 3:
                die("下载转写结果失败: %s: %s" % (type(e).__name__, e))
            time.sleep(1.5 * attempt)


def to_ir(doc):
    """transcripts[].sentences[] → [{s,e,z,w}]。

    句子文本保留标点（下游 norm() 负责去标点；LLM 裁决看带标点的原文更准）。
    词时间戳原样搬过来：paraformer-v2 对齐后是**字级**（每个汉字一个 token，
    数字/英文串保持成组），字间空隙即真实停顿。
    """
    sents = []
    for tr in doc.get("transcripts") or []:
        sents.extend(tr.get("sentences") or [])
    ir = []
    for s in sents:
        words = []
        for w in (s.get("words") or []):
            txt = (w.get("text") or "").strip()
            if not txt:
                continue
            words.append([round((w.get("begin_time") or 0) / 1000.0, 2),
                          round((w.get("end_time") or 0) / 1000.0, 2),
                          txt])
        text = (s.get("text") or "").strip()
        if not text:
            continue
        ir.append({
            "s": round((s.get("begin_time") or 0) / 1000.0, 2),
            "e": round((s.get("end_time") or 0) / 1000.0, 2),
            "z": text,
            "w": words,
        })
    ir.sort(key=lambda x: x["s"])
    return ir


def main():
    if len(sys.argv) < 3:
        die("用法: python asr_cloud.py <音频.wav> <句段输出.json>")
    wav, segs_out = sys.argv[1], sys.argv[2]
    if not os.path.exists(wav):
        die("找不到音频: %s" % wav)

    dashscope.api_key = pick_key()
    t0 = time.time()

    size_mb = os.path.getsize(wav) / 1024.0 / 1024.0
    print("ASR_CLOUD upload %.1fMB model=%s" % (size_mb, MODEL), flush=True)
    fid, url = upload(wav)

    out = transcribe(url)
    doc = fetch_doc(out)
    ir = to_ir(doc)
    if not ir:
        die("转写结果没有任何句段（音频为空或格式不支持）")

    with open(segs_out, "w", encoding="utf-8") as f:
        json.dump(ir, f, ensure_ascii=False)

    dur = ir[-1]["e"]
    cost = dur * PRICE_PER_SEC
    elapsed = time.time() - t0
    print("ASR_CLOUD ok segs=%d dur=%.1fs wall=%.1fs file_id=%s"
          % (len(ir), dur, elapsed, fid))
    # 账单行：run.mjs 解析后并入 work/run-usage.json
    print("ASR_USAGE " + json.dumps({
        "provider": "cloud",
        "model": MODEL,
        "seconds": round(dur, 2),
        "cost": round(cost, 6),
        "wallSec": round(elapsed, 1),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
