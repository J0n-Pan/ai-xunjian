// 把 ASR 的「整句字幕」再切成更细的小块，供剪辑台的字幕条使用。
//
// 为什么需要：ASR 的 raw-segs 是句子级的，一段常有 6~12 秒。用户点一格就删掉十几秒，
// 颗粒度太粗。这里用字/词级时间戳（w: [[s,e,text],...]）在标点和词边界上再切一刀，
// 得到 1~3 秒级别的小块；时间戳一律来自 ASR，不做比例估算（除了 w 缺失时的兜底）。
const PUNCT = new Set([..."，,。.！!？?；;：:、…·"]);

const isPunct = (ch) => PUNCT.has(ch);
const isSpace = (ch) => /\s/.test(ch);

// 把 z 的每个字符映射到时间区间。返回 { st, en, tok }：st/en 为字符起止，tok 标记新词起点。
function buildTimeline(z, w, s0, e0) {
  const n = z.length;
  const st = new Array(n).fill(null);
  const en = new Array(n).fill(null);
  const tok = new Array(n).fill(false);

  let ci = 0;
  let prevEnd = s0;
  let hits = 0;
  let miss = 0;

  for (const it of Array.isArray(w) ? w : []) {
    const txt = String(it?.[2] ?? "");
    const ws = +it?.[0];
    const we = +it?.[1];
    if (!txt || !Number.isFinite(ws) || !Number.isFinite(we) || we < ws) continue;
    // ASR 偶尔会有空格/标点误差，用 indexOf 从上次位置往后找，跳过的字符归到上一个词尾
    const k = z.indexOf(txt, ci);
    if (k < 0) { miss++; continue; }
    for (let i = ci; i < k; i++) { st[i] = prevEnd; en[i] = prevEnd; }
    for (let i = k; i < k + txt.length && i < n; i++) { st[i] = ws; en[i] = we; }
    if (k < n) tok[k] = true;
    ci = k + txt.length;
    prevEnd = we;
    hits++;
  }
  for (let i = ci; i < n; i++) { st[i] = prevEnd; en[i] = prevEnd; }

  // 词条对不上（英文/数字混排等）：整句按字数比例兜底，至少不会错位到别的句子
  const broken = !hits || miss > Math.max(2, hits * 0.2) || st.some((v) => v == null);
  if (broken) {
    const real = [];
    for (let i = 0; i < n; i++) if (!isSpace(z[i])) real.push(i);
    const span = (e0 - s0) / Math.max(1, real.length);
    real.forEach((i, k) => {
      st[i] = s0 + span * k;
      en[i] = s0 + span * (k + 1);
      if (k === 0) st[i] = s0;
      if (k === real.length - 1) en[i] = e0;
    });
    // 没有词边界信息时，把每个字都当成可切点，否则这类长句（常见于纯口播 ASR 漏词）
    // 会整段 10 秒以上切不动
    tok.fill(false);
    for (const i of real) tok[i] = true;
  }
  return { st, en, tok };
}

export function splitSubs(segs, opt = {}) {
  const maxDur = opt.maxDur ?? 3.6;
  const maxChars = opt.maxChars ?? 14;
  const minDur = opt.minDur ?? 0.4;
  const out = [];

  for (const seg of segs || []) {
    const z = String(seg?.z ?? "").trim();
    const s0 = +seg?.s;
    const e0 = +seg?.e;
    if (!z || !Number.isFinite(s0) || !Number.isFinite(e0) || !(e0 > s0)) continue;

    const tl = buildTimeline(z, seg.w, s0, e0);
    const span = (a, b) => {          // 字符区间 [a,b) 的时间与字数
      let s = Infinity, e = -Infinity, c = 0;
      for (let i = a; i < b && i < z.length; i++) {
        if (isSpace(z[i])) continue;
        if (tl.st[i] != null) s = Math.min(s, tl.st[i]);
        if (tl.en[i] != null) e = Math.max(e, tl.en[i]);
        if (!isPunct(z[i])) c++;
      }
      return { s: Number.isFinite(s) ? s : s0, e: Number.isFinite(e) ? e : e0, c };
    };

    const cuts = [];                  // 先按标点切
    let a = 0;
    for (let i = 0; i < z.length; i++) {
      if (isPunct(z[i])) { cuts.push([a, i + 1]); a = i + 1; }
    }
    if (a < z.length) cuts.push([a, z.length]);

    const fine = [];
    const cutLong = (b, e) => {       // 仍然过长的块：在词边界上二分
      const { s, e: eEnd, c } = span(b, e);
      if (eEnd - s <= maxDur && c <= maxChars) { fine.push([b, e]); return; }
      const mid = s + (eEnd - s) / 2;
      let best = -1, bestScore = Infinity;
      for (let i = b + 1; i < e; i++) {
        if (!tl.tok[i] || isPunct(z[i]) || isSpace(z[i])) continue;
        const cs = span(b, i), ce = span(i, e);
        if (cs.c < 2 || ce.c < 2) continue;
        const gap = Math.max(0, (tl.st[i] ?? 0) - (tl.en[i - 1] ?? 0));
        const score = Math.abs((tl.st[i] ?? mid) - mid) - gap * 0.9;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) { fine.push([b, e]); return; }
      cutLong(b, best);
      cutLong(best, e);
    };
    for (const [b, e] of cuts) cutLong(b, e);

    for (const [b, e] of fine) {
      const txt = z.slice(b, e).trim().replace(/^[，,。.！!？?；;：:、…·]+/, "");
      if (!txt) continue;
      const { s, e: eEnd } = span(b, e);
      const last = out[out.length - 1];
      // 太短的碎块并回上一块（只并同一句内），否则字幕条上会出现点不中的 0.2 秒格子
      if (eEnd - s < minDur && last && last._seg === e0 && last.z.length < maxChars * 1.8) {
        last.e = Math.max(last.e, eEnd);
        last.z = (last.z + txt).trim();
        continue;
      }
      out.push({ s, e: eEnd, z: txt, _seg: e0 });
    }
  }

  return out.map(({ s, e, z }) => ({ s: +s.toFixed(3), e: +e.toFixed(3), z }));
}
