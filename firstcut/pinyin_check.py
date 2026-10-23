# -*- coding: utf-8 -*-
# 错字纠错护栏:校验 (from, to) 是否"读音相近"(同音/近音替换)。
# 用法: uv run --with pypinyin python pinyin_check.py <in.json> <out.json>
# in.json  = [["原句","改句"], ...]
# out.json = [{"whole":0.93,"span":0.86,"changed":2}, ...]
#   whole = 整句拼音相似度; span = **仅改动区**的拼音相似度(判别力更强); changed = 改动字符数
import sys, json, re, difflib

_ZH = re.compile(r"[^\u4e00-\u9fffA-Za-z0-9]")


def norm(s):
    return _ZH.sub("", str(s or ""))


def py(s):
    from pypinyin import lazy_pinyin
    return " ".join(lazy_pinyin(s))


def ratio(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio() if (a or b) else 0.0


inp = json.load(open(sys.argv[1], encoding="utf-8"))
out = []
for pair in inp:
    a, b = norm(pair[0]), norm(pair[1])
    whole = ratio(py(a), py(b))
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    src, dst, changed = [], [], 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        src.append(a[i1:i2])
        dst.append(b[j1:j2])
        changed += max(i2 - i1, j2 - j1)
    span = ratio(py("".join(src)), py("".join(dst)))
    out.append({"whole": round(whole, 3), "span": round(span, 3), "changed": changed})
with open(sys.argv[2], "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
print("PINYIN_DONE", len(out))
