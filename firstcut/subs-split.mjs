// 把 ASR 的「整句字幕」切成更细的小块，供剪辑台的字幕条使用。
//
// 两条硬规则，都是为了不把词切开：
//   ① 只在标点处切（，。？！；：、…）—— 标点天然是词边界；
//   ② 分句仍过长时，只在该句内部的「停顿」处切（相邻字之间 ≥120ms 的静音）。
// **绝不按字数切**：ASR 的 w 是逐字时间戳（"本身" 会拆成 本/身 两条），
// 拿它当词边界会把「本身」劈成「本 | 身」，这正是之前字幕条断句碎掉的原因。
// 实在没有停顿又超长的句子，宁可留长一点，也不切词。
const PUNCT = new Set([..."，,。.！!？?；;：:、…·"]);

const isPunct = (ch) => PUNCT.has(ch);
const isSpace = (ch) => /\s/.test(ch);

// 每个字符对应的时间区间。st/en 按 w 的字级时间戳填，标点归到前一字末尾。
function buildTimeline(z, w, s0, e0) {
  const n = z.length;
  const st = new Array(n).fill(null);
  const en = new Array(n).fill(null);

  let ci = 0;
  let prevEnd = s0;
  let hits = 0;
  let miss = 0;

  for (const it of Array.isArray(w) ? w : []) {
    const txt = String(it?.[2] ?? "");
    const ws = +it?.[0];
    const we = +it?.[1];
    if (!txt || !Number.isFinite(ws) || !Number.isFinite(we) || we < ws) continue;
    const k = z.indexOf(txt, ci);
    if (k < 0) { miss++; continue; }
    for (let i = ci; i < k; i++) { st[i] = prevEnd; en[i] = prevEnd; }
    for (let i = k; i < k + txt.length && i < n; i++) { st[i] = ws; en[i] = we; }
    ci = k + txt.length;
    prevEnd = we;
    hits++;
  }
  for (let i = ci; i < n; i++) { st[i] = prevEnd; en[i] = prevEnd; }

  // 对不上（英文/数字混排等）：整句按字数均分。只用来算时间，不当作切点。
  const broken = !hits || miss > Math.max(2, hits * 0.2) || st.some((v) => v == null);
  if (broken) {
    const real = [];
    for (let i = 0; i < n; i++) if (!isSpace(z[i])) real.push(i);
    const span = (e0 - s0) / Math.max(1, real.length);
    real.forEach((i, k) => {
      st[i] = k === 0 ? s0 : s0 + span * k;
      en[i] = k === real.length - 1 ? e0 : s0 + span * (k + 1);
    });
  }
  return { st, en, broken };
}

export function splitSubs(segs, opt = {}) {
  const maxDur = opt.maxDur ?? 4.5;     // 一个分句超过这个时长才考虑在停顿处再切
  const minGap = opt.minGap ?? 0.12;    // 停顿门槛：小于这个不当切点（气口/字间抖动）
  const mergeDur = opt.mergeDur ?? 1.0; // 短于这个的分句并进邻居，避免出现点不中的细格子
  const mergeCap = opt.mergeCap ?? 3.2; // 合并后的上限
  const out = [];

  for (const seg of segs || []) {
    const z = String(seg?.z ?? "").trim();
    const s0 = +seg?.s;
    const e0 = +seg?.e;
    if (!z || !Number.isFinite(s0) || !Number.isFinite(e0) || !(e0 > s0)) continue;

    const { st, en, broken } = buildTimeline(z, seg.w, s0, e0);

    const span = (a, b) => {          // 字符区间 [a,b) 的时间与字数
      let s = Infinity, e = -Infinity, c = 0;
      for (let i = a; i < b && i < z.length; i++) {
        if (isSpace(z[i])) continue;
        if (st[i] != null) s = Math.min(s, st[i]);
        if (en[i] != null) e = Math.max(e, en[i]);
        if (!isPunct(z[i])) c++;
      }
      return { s: Number.isFinite(s) ? s : s0, e: Number.isFinite(e) ? e : e0, c };
    };

    // ① 先按标点切
    const rough = [];
    let a = 0;
    for (let i = 0; i < z.length; i++) {
      if (isPunct(z[i])) { rough.push([a, i + 1]); a = i + 1; }
    }
    if (a < z.length) rough.push([a, z.length]);

    // ② 仍过长的，只在停顿处再切；没有停顿就整段留着（宁可粗，不可断词）
    const parts = [];
    const cutAtPause = (b, e) => {
      const sp = span(b, e);
      if (sp.e - sp.s <= maxDur || broken) { parts.push([b, e]); return; }
      const mid = sp.s + (sp.e - sp.s) / 2;
      let best = -1, bestScore = -Infinity;
      for (let i = b + 1; i < e; i++) {
        const gap = (st[i] ?? 0) - (en[i - 1] ?? 0);
        if (gap < minGap) continue;
        if (span(b, i).c < 2 || span(i, e).c < 2) continue;
        const into = (st[i] - sp.s) / (sp.e - sp.s);
        if (into < 0.2 || into > 0.8) continue;   // 别在两端切出一两个字
        const score = gap - Math.abs(st[i] - mid) * 0.06;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) { parts.push([b, e]); return; }
      cutAtPause(b, best);
      cutAtPause(best, e);
    };
    for (const [b, e] of rough) cutAtPause(b, e);

    // ③ 过短的分句并进邻居（同一句内），合并后不超过 mergeCap
    for (let i = 0; i < parts.length; i++) {
      const [b, e] = parts[i];
      const cur = span(b, e);
      const prev = i > 0 ? span(parts[i - 1][0], parts[i - 1][1]) : null;
      const next = i < parts.length - 1 ? span(parts[i + 1][0], parts[i + 1][1]) : null;
      if (cur.e - cur.s >= mergeDur) continue;
      if (prev && cur.e - prev.s <= mergeCap) {
        parts[i - 1][1] = e;
        parts.splice(i, 1); i -= 2;
      } else if (next && next.e - cur.s <= mergeCap) {
        parts[i][1] = parts[i + 1][1];
        parts.splice(i + 1, 1); i -= 1;
      }
    }

    for (const [b, e] of parts) {
      const txt = z.slice(b, e).trim().replace(/^[，,。.！!？?；;：:、…·]+/, "");
      if (!txt) continue;
      const { s, e: eEnd } = span(b, e);
      const last = out[out.length - 1];
      if (eEnd - s < mergeDur && last && last._seg === e0 && last.z.length < 16) {
        last.e = Math.max(last.e, eEnd);
        last.z = (last.z + txt).trim();
        continue;
      }
      out.push({ s, e: eEnd, z: txt, _seg: e0 });
    }
  }

  return out.map(({ s, e, z }) => ({ s: +s.toFixed(3), e: +e.toFixed(3), z }));
}
