# -*- coding: utf-8 -*-
"""拼接边界幻觉回归检查 —— 成片字幕里"凭空多出来的字"是否落在剪切边界上。

原理：
  ① 把原片转写(work/raw-segs.json)与成片转写(work/caps-full.json)各自拼成纯文本；
  ② 成片 = 原片删掉若干段，所以正常情况原片文本应"包含"成片文本(只少不多)；
     用 difflib 对齐后，opcode='insert' 的部分就是成片里**多出来的字** = 幻觉候选；
  ③ 每条幻觉按字幕行内位置插值出"成片时间"，再用 work/cut-plan.json 的
     保留段/提速比把成片时间反算回原片时间，看它离最近的拼接边界有多远。
     贴边(≤ --tol 秒)的即判为"边界幻觉"。

用法: python check-boundaries.py <episodes/工程名> [<工程名> ...] [--tol 0.6] [--json 输出.json]
"""
import sys, os, json, re, ast, difflib, argparse

PUNCT = "，,。.、；;：:！!？?…—·\"“”'‘’（）()《》〈〉【】 \t\r\n"

# 从 asr_and_caps.py 里读出错字订正词典：原片转写未应用 FIXES，成片字幕应用了，
# 不归一化的话「李维→李威」「寄→记」这类词典纠正会被误报成"成片多出来的字"。
def load_fixes():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr_and_caps.py")
    try:
        with open(p, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                    getattr(t, "id", "") == "FIXES" for t in node.targets):
                return [tuple(x) for x in ast.literal_eval(node.value)]
    except Exception as e:
        print(f"  (FIXES 未读到，按空表处理: {e})", file=sys.stderr)
    return []


FIXES = load_fixes()


def norm(s):
    return "".join(ch for ch in str(s) if ch not in PUNCT)


def apply_fixes(s):
    for bad, good in FIXES:
        s = s.replace(bad, good)
    return s



def load(p, default=None):
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def caps_to_text(caps):
    """返回 (拼接文本, [(char_start, char_end, s, e)])"""
    txt, spans, pos = "", [], 0
    for c in caps:
        z = norm(c.get("z", ""))
        if not z:
            continue
        spans.append((pos, pos + len(z), float(c["s"]), float(c["e"])))
        txt += z
        pos += len(z)
    return txt, spans


def out_time_of_char(spans, idx):
    """成片时间轴上第 idx 个字符的大致时刻(行内线性插值)"""
    for a, b, s, e in spans:
        if a <= idx < b:
            return s if b == a else s + (e - s) * (idx - a) / (b - a)
    return spans[-1][3] if spans else 0.0


def boundary_times(segs, speed):
    """拼接边界在成片时间轴上的位置:每段起点与末段终点"""
    out, cum = [], 0.0
    for i, (s, e) in enumerate(segs):
        if i > 0:
            out.append(cum / speed)
        cum += (e - s)
        out.append(cum / speed)
    return out


def check(ep, tol):
    work = os.path.join(ep, "work")
    plan = load(os.path.join(work, "cut-plan.json"))
    raw = load(os.path.join(work, "raw-segs.json"), [])
    caps = load(os.path.join(work, "caps-full.json"), [])
    if not caps:
        return None
    in_txt = apply_fixes(norm("".join(s.get("z", "") for s in raw)))
    out_txt, spans = caps_to_text(caps)
    sm = difflib.SequenceMatcher(None, in_txt, out_txt, autojunk=False)
    ins = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        t = out_time_of_char(spans, j1)
        extra = out_txt[j1:j2]
        miss = in_txt[i1:i2]
        if tag == "insert":
            kind, note = "insert", ""                      # 凭空多出 → 幻觉主证据
        elif len(extra) > len(miss):
            kind, note = "expand", f"原片「{miss}」→ 成片「{extra}」"
        elif len(extra) == len(miss):
            kind, note = "swap", f"同音/近音替换 原片「{miss}」"   # ASR 抖动，非幻觉
        else:
            kind, note = "shrink", f"原片「{miss}」→ 成片「{extra}」"
        ins.append({"at_out": round(t, 2), "text": extra, "kind": kind, "note": note})
    bnd = []
    if plan:
        segs = plan.get("segs") or []
        bnd = boundary_times([tuple(x) for x in segs], plan.get("speed", 1.0))
    for x in ins:
        d = min((abs(x["at_out"] - b) for b in bnd), default=None)
        x["boundary_dist"] = None if d is None else round(d, 2)
        x["on_boundary"] = bool(d is not None and d <= tol)
    halluc = [x for x in ins if x["kind"] in ("insert", "expand")]
    return {"episode": os.path.basename(ep.rstrip("/\\")),
            "segments": len(plan.get("segs", [])) if plan else 0,
            "inner_boundaries": max(0, (len(plan.get("segs", [])) - 1) * 2) if plan else 0,
            "in_chars": len(in_txt), "out_chars": len(out_txt),
            "insertions": ins,
            "halluc": [x for x in halluc],
            "halluc_chars": sum(len(x["text"]) for x in halluc),
            "boundary_halluc": [x for x in halluc if x["on_boundary"]],
            "swaps": sum(1 for x in ins if x["kind"] == "swap")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("episodes", nargs="+")
    ap.add_argument("--tol", type=float, default=0.6, help="判定'贴边'的容差秒数")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    results = []
    for ep in a.episodes:
        r = check(ep, a.tol)
        if r is None:
            print(f"✗ {ep}: 无 caps-full.json，跳过")
            continue
        results.append(r)
        print(f"\n=== {r['episode']} ===")
        print(f"  保留段 {r['segments']} · 内部拼接边界 {r['inner_boundaries']} 个 · "
              f"原片 {r['in_chars']} 字 → 成片 {r['out_chars']} 字")
        print(f"  幻觉候选(凭空多出/变长) {len(r['halluc'])} 处 / {r['halluc_chars']} 字，"
              f"其中贴边(≤{a.tol}s) {len(r['boundary_halluc'])} 处 · 同音替换(噪声) {r['swaps']} 处")
        for x in r["insertions"]:
            tag = "⚠️ 边界幻觉" if x["on_boundary"] and x["kind"] in ("insert", "expand") else \
                  ("◆ 幻觉候选" if x["kind"] in ("insert", "expand") else "· 同音/收缩(噪声)")
            d = "n/a" if x["boundary_dist"] is None else f"{x['boundary_dist']}s"
            print(f"    {tag} @{x['at_out']}s (距边界 {d}) 「{x['text']}」{x['note']}")
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(f"\n已写出 {a.json}")


if __name__ == "__main__":
    main()
