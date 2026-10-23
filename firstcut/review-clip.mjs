// 审核队列与「最终保留段」求交 —— 只留真正还能剪的地方。
//
// 起因：气口检测会先剪掉大段静音（实测 C0793 剪掉 48.3s），而语义裁决拿的是**原片句段**，
// 于是队列里会出现「这句在中段、模型想删」但该时间段早已被气口剪掉的条目。
// 用户点「删除」没有任何效果 —— 这不是"保守"，是假按钮。所以落盘前必须裁掉。
const TOL = 0.12;   // 小于 120ms 的交集不值得操作（听感上也听不出来）

function merge(list) {
  if (!list.length) return [];
  const s = list.slice().sort((a, b) => a[0] - b[0]);
  const out = [s[0].slice()];
  for (const [a, b] of s.slice(1)) {
    const last = out[out.length - 1];
    if (a - last[1] <= 0.01) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function clipCuts(cuts, kept) {
  const out = [];
  for (const r of cuts || []) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const [s, e] = r;
    for (const [a, b] of kept) {
      const x = Math.max(s, a), y = Math.min(e, b);
      if (y - x > TOL) out.push([+x.toFixed(3), +y.toFixed(3)]);
    }
  }
  return merge(out);
}

// 返回 { items, dropped }：dropped 是"落在已剪区间、已失效"的条目数
export function clipReviewItems(items, kept) {
  const res = [];
  let dropped = 0;
  for (const it of items || []) {
    const options = (it.options || []).map((o) => ({
      ...o,
      cuts: clipCuts(o.cuts || [], kept),
    }));
    const del = options.find((o) => o.cuts && o.cuts.length);
    if (!del) { dropped++; continue; }
    const s = Math.min(...del.cuts.map((c) => c[0]));
    const e = Math.max(...del.cuts.map((c) => c[1]));
    res.push({ ...it, s: +s.toFixed(3), e: +e.toFixed(3), options });
  }
  return { items: res, dropped };
}

// ── 决定 → 有效片段表 ──
// 基线计划永远不动（cut-plan.json），决定是叠加在上面的增量。
// 这样反复重剪是幂等的：不会因为上次已经减过而越剪越短。
const EPS = 1e-6;

export function subtract(segs, [a, b]) {
  const out = [];
  for (const [s, e] of segs) {
    if (b <= s + EPS || a >= e - EPS) { out.push([s, e]); continue; }
    if (a > s + EPS) out.push([s, Math.min(a, e)]);
    if (b < e - EPS) out.push([Math.max(b, s), e]);
  }
  return out;
}

export function applyDecisions(segs, decisions) {
  let out = (segs || []).map(([s, e]) => [s, e]);
  for (const d of decisions || []) {
    if (d.choice !== "cut") continue;
    for (const r of d.cuts || []) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const a = Number(r[0]), b = Number(r[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      out = subtract(out, [a, b]);
    }
  }
  return out.filter(([s, e]) => e - s > 0.12).sort((x, y) => x[0] - y[0]);
}
