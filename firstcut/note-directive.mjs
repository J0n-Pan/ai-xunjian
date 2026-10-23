// 用户补充要求 → 精确剪点
//
// 背景（2026-10-23 用户实测）：「AI 剪辑」弹窗里填「删掉『有人能够在1个小时之内记住几百个』…」
// 成片毫无变化。原因是那句话只被追加到四份裁决提示词末尾当"参考"，而四类裁决的候选集
// 来自确定性检测（重说/卡壳/语气词/冗余），用户点名要删的句子压根不在候选里 →
// 模型无权新增剪点，只能对已有候选表态。表现就是"输入什么都不影响结果"。
//
// 这里补上缺失的一环：把要求翻译成**时间区间**，直接并入剪切表。
//   ① LLM 解析（arbiter-prompt-directive.md）拿到 ids / 原文引用；
//   ② 确定性兜底：引号里的原句 + 按标点切出的短句，逐条在转写里定位。
// 两种通道都落到同一个「字→时间」流上，所以哪怕模型不可用，只要用户抄了原话也一定剪得动。
const CJK = /[\u4e00-\u9fff]/;

// 繁→简：paraformer 出简体、whisper 出繁体（或反过来），不做归一化时"抄原话"会假性匹配失败。
// 只收口播里高频的那一批，剩下的交给下面的模糊匹配（阈值 0.72）兜。
const T2S = {
  個: "个", 這: "这", 們: "们", 說: "说", 時: "时", 會: "会", 對: "对", 學: "学", 覺: "觉",
  麼: "么", 為: "为", 與: "与", 於: "于", 過: "过", 還: "还", 讓: "让", 從: "从", 來: "来",
  現: "现", 實: "实", 點: "点", 樣: "样", 電: "电", 話: "话", 問: "问", 題: "题", 開: "开",
  關: "关", 係: "系", 應: "应", 該: "该", 認: "认", 識: "识", 記: "记", 憶: "忆", 練: "练",
  習: "习", 體: "体", 驗: "验", 錯: "错", 誤: "误", 轉: "转", 變: "变", 註: "注", 頁: "页",
  兩: "两", 種: "种", 類: "类", 數: "数", 據: "据", 資: "资", 產: "产", 業: "业", 務: "务",
  員: "员", 場: "场", 環: "环", 頭: "头", 腦: "脑", 髮: "发", 誰: "谁", 著: "着", 後: "后",
  並: "并", 內: "内", 無: "无", 強: "强", 長: "长", 間: "间", 見: "见", 給: "给", 沒: "没",
  準: "准", 備: "备", 決: "决", 定: "定", 達: "达", 進: "进", 動: "动", 態: "态",
  幫: "帮", 剛: "刚", 塊: "块", 錢: "钱", 賣: "卖",
  買: "买", 讀: "读", 寫: "写", 聽: "听", 講: "讲", 語: "语", 詞: "词", 標: "标",
  簡: "简", 單: "单", 複: "复", 雜: "杂", 難: "难", 嚐: "尝", 試: "试",
};

// 只留「可能出现在转写里」的字符：汉字/字母/数字，标点与空白全部丢掉。
// 这样用户抄句子时多打一个「，」、少打一个「。」都不会影响定位。
export const nrm = (s) =>
  [...String(s || "")].map((c) => T2S[c] || c).join("").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");

// 逐字时间轴。词级时间戳（w）优先；缺失或长度对不上时按字数在句段内线性铺开
// （误差不超过一句内的语速抖动，切口随后还要过一次静音吸附，实际听感无损）。
export function buildTimeline(segs) {
  const out = [];
  for (const sg of segs || []) {
    const full = nrm(sg.z);
    if (!full || !(sg.e > sg.s)) continue;
    const chars = [];
    for (const w of sg.w || []) {
      if (!Array.isArray(w) || w.length < 3) continue;
      const t = nrm(w[2]);
      if (!t) continue;
      const ws = Number(w[0]), we = Number(w[1]);
      if (!Number.isFinite(ws) || !Number.isFinite(we) || we < ws) continue;
      const per = (we - ws) / t.length;
      for (let k = 0; k < t.length; k++) chars.push([t[k], ws + per * k, ws + per * (k + 1)]);
    }
    if (chars.length !== full.length) {
      chars.length = 0;
      const per = (sg.e - sg.s) / full.length;
      for (let k = 0; k < full.length; k++) chars.push([full[k], sg.s + per * k, sg.s + per * (k + 1)]);
    }
    for (const [ch, t0, t1] of chars) out.push({ ch, t0, t1 });
  }
  return out;
}

// 在一维字流里找一句话。允许 ±2 字的长度错配与少量字不同（简繁残留、ASR 同音字）。
// 返回 {s,e,score,text}；score < minScore 视为没找到 —— 宁可不剪，也不能剪错地方。
export function locate(quote, timeline, minScore = 0.72) {
  const q = nrm(quote);
  if (q.length < 4 || !timeline || timeline.length < q.length - 2) return null;
  let best = null;
  const nMax = Math.min(q.length + 2, timeline.length);
  for (let n = Math.max(4, q.length - 2); n <= nMax; n++) {
    for (let p = 0; p + n <= timeline.length; p++) {
      let m = 0;
      const k = Math.min(q.length, n);
      for (let i = 0; i < k; i++) if (timeline[p + i].ch === q[i]) m++;
      const score = m / Math.max(q.length, n);
      if (!best || score > best.score) best = { score, p, n };
      if (best.score >= 1) break;
    }
    if (best && best.score >= 1) break;
  }
  if (!best || best.score < minScore) return null;
  const a = timeline[best.p], b = timeline[best.p + best.n - 1];
  return {
    s: +a.t0.toFixed(3),
    e: +b.t1.toFixed(3),
    score: +best.score.toFixed(3),
    text: timeline.slice(best.p, best.p + best.n).map((x) => x.ch).join(""),
  };
}

// 一句话里夹着多段引用（用户常常一次点名两三处）时，整串匹配会因为中间隔着别的内容而失败。
// 按空白切成若干段分别定位，全部命中才算成功 —— 只命中一部分说明引用本身不可靠，宁可退回 ids。
export function locateParts(quote, timeline) {
  const parts = String(quote || "").split(/\s+/).map((s) => s.trim()).filter((s) => nrm(s).length >= 4);
  if (parts.length < 2) return null;
  const hits = [];
  for (const p of parts) {
    const h = locate(p, timeline);
    if (!h) return null;
    hits.push(h);
  }
  return hits;
}

// 要求里被"引用"的原句：中英文引号都认。用户抄原话时几乎一定会加引号。
export function quotedParts(note) {
  const out = [];
  const re = /[「『“"'‘]([^」』”"'’]{3,80})[」』”"'’]/g;
  let m;
  while ((m = re.exec(String(note || "")))) {
    const t = m[1].trim();
    if (t && CJK.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

// 没加引号时的兜底：按标点/空白切成短句，滤掉纯指令词。
// 「删掉 A 有人能够一遍记住」这种连写的输入也能拆出 A 与 B 两段。
const STOP = /^(删掉|删除|去掉|不要|别|剪掉|保留|留着|这句话|那句|这里|那里|掉|一下|吧|啊)$/;
export function clauseParts(note) {
  return String(note || "")
    .split(/[\s，,、。；;：:！!？?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && CJK.test(s) && !STOP.test(s));
}

const mergeRanges = (list, gap = 0.12) => {
  const s = list.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    if (!(b > a)) continue;
    const l = out[out.length - 1];
    if (l && a <= l[1] + gap) l[1] = Math.max(l[1], b);
    else out.push([a, b]);
  }
  return out;
};

/**
 * 解析一句补充要求 → 剪点/保护点。
 * @param note      用户在「AI 剪辑」弹窗里填的那句话
 * @param segs      原片句段（含词级时间戳）
 * @param dur       原片时长
 * @param adjudicate  run.mjs 里的裁决函数（同步）；传 null 则只走确定性通道
 * @returns {{cuts:number[][], keeps:number[][], log:string[], report:object}}
 */
export function resolveNoteDirectives({ note, segs, dur, adjudicate }) {
  const text = String(note || "").trim();
  const res = { cuts: [], keeps: [], log: [], report: { note: text, actions: [], unmatched: [] } };
  if (!text) return res;

  const timeline = buildTimeline(segs);
  const actions = [];      // {op:"cut"|"keep", ids?:[], quote?:string, reason?:string, by:string}
  let modelUsed = false;

  // ── ① LLM 解析 ──
  if (adjudicate) {
    const lines = (segs || []).map((x, i) => ({ id: i, s: +x.s.toFixed(2), e: +x.e.toFixed(2), text: nrm(x.z) }));
    const v = adjudicate("directive", { note: text, dur: +(dur || 0).toFixed(2), lines });
    if (v && Array.isArray(v.actions)) {
      modelUsed = true;
      for (const a of v.actions) {
        if (!a || typeof a !== "object") continue;
        const op = a.op === "keep" ? "keep" : "cut";
        actions.push({
          op,
          ids: Array.isArray(a.ids) ? a.ids.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [],
          quote: typeof a.quote === "string" ? a.quote.trim() : "",
          reason: typeof a.reason === "string" ? a.reason.slice(0, 60) : "",
          by: "模型",
        });
      }
      res.report.actions = actions.map((a) => ({ ...a }));
    }
  }

  // ── ② 确定性兜底：引号原句（模型没给动作，或给了但没覆盖这句）──
  // 用户说"保留/别剪"时，引号里的是**保护点**而不是剪点 —— 抄原话的通道不能反着来。
  const KEEP_HINT = /(保留|别剪|不要剪|别删|不要删|留着|别动)/;
  const CUT_HINT = /(删|去掉|剪掉|丢掉|不要|不想要|去掉)/;
  const op = KEEP_HINT.test(text) && !CUT_HINT.test(text) ? "keep" : "cut";
  const quoted = quotedParts(text);
  const covered = (q) => actions.some((a) => a.quote && nrm(a.quote).includes(nrm(q).slice(0, 6)));
  for (const q of quoted) if (!covered(q)) actions.push({ op, ids: [], quote: q, reason: "用户原样引用", by: "引用" });
  // 完全没有引号、且模型没给动作 → 按分句猜（只在这一种情况下用，避免误剪）
  if (!quoted.length && !modelUsed) {
    for (const c of clauseParts(text)) actions.push({ op, ids: [], quote: c, reason: "从要求中解析的短句", by: "分句" });
  }
  if (!actions.length) return res;

  // ── ③ 动作 → 时间区间 ──
  // 优先级：原文引用（精确到字）> 整句 id（粗到句）。两者都给时以引用为准 ——
  // 实测模型会同时返回 ids=[6,7] 与一段引用，若两者都采纳，用户只想删两句尾巴，
  // 结果整两段 24s 全没了。
  const cutRaw = [], keepRaw = [];
  for (const a of actions) {
    const bucket = a.op === "keep" ? keepRaw : cutRaw;
    const tag = a.op === "keep" ? "⊘ 保留" : "✂ 删";
    let added = 0;
    if (a.quote) {
      const hit = locate(a.quote, timeline);
      const parts = hit ? null : locateParts(a.quote, timeline);
      if (hit) {
        bucket.push([hit.s, hit.e]);
        added++;
        res.log.push(`${tag} [${fmt(hit.s)}-${fmt(hit.e)}]（${a.by}·${hit.score}）「${hit.text.slice(0, 24)}」${a.reason ? " · " + a.reason : ""}`);
      } else if (parts) {
        for (const h of parts) {
          bucket.push([h.s, h.e]);
          added++;
          res.log.push(`${tag} [${fmt(h.s)}-${fmt(h.e)}]（${a.by}·${h.score}）「${h.text.slice(0, 24)}」`);
        }
      }
    }
    if (!added) {
      for (const id of a.ids) {
        const sg = segs[id];
        if (!sg) continue;
        bucket.push([+sg.s.toFixed(3), +sg.e.toFixed(3)]);
        added++;
        res.log.push(`${tag} [${fmt(sg.s)}-${fmt(sg.e)}]（${a.by}·整句#${id}）「${nrm(sg.z).slice(0, 24)}」`);
      }
    }
    if (!added) res.report.unmatched.push(a.quote || `ids=${a.ids.join(",")}`);
  }

  let cuts = mergeRanges(cutRaw, 0.15);
  // 硬护栏：单条要求不许把整片删光（用户显然不会想删 60% 以上；真那样多半是定位错了）
  const total = cuts.reduce((n, [a, b]) => n + (b - a), 0);
  const cap = (dur || 0) * 0.6;
  if (dur > 0 && total > cap) {
    res.log.push(`⚠️ 要求命中的总时长 ${total.toFixed(1)}s 超过全片 60%（${cap.toFixed(1)}s），已按比例截断 —— 请检查要求是否写得太宽泛`);
    const k = cap / total;
    cuts = cuts.map(([a, b]) => [+a.toFixed(3), +(a + (b - a) * k).toFixed(3)]);
  }
  res.cuts = cuts;
  res.keeps = mergeRanges(keepRaw, 0.15);
  // 保护点与剪点冲突时，保护优先
  if (res.keeps.length) {
    const out = [];
    for (const [a, b] of res.cuts) {
      let parts = [[a, b]];
      for (const [ks, ke] of res.keeps) {
        const next = [];
        for (const [x, y] of parts) {
          if (ke <= x || ks >= y) { next.push([x, y]); continue; }
          if (ks > x) next.push([x, Math.min(ks, y)]);
          if (ke < y) next.push([Math.max(ke, x), y]);
        }
        parts = next;
      }
      out.push(...parts.filter(([x, y]) => y - x > 0.2));
    }
    res.cuts = mergeRanges(out, 0.15);
  }
  return res;
}

function fmt(t) {
  const m = Math.floor(t / 60), s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
