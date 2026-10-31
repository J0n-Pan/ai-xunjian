// 记账：这一轮初剪到底花了多少钱。
//
// 为什么要单独一个模块：run.mjs 是同步长流程，四个裁决点都是 spawn 子进程调 llm.mjs，
// 子进程各自把 usage 追加到同一个 jsonl（XUNJIAN_USAGE_LOG），父进程只负责在收尾时汇总。
// 汇总结果写 work/run-usage.json，服务端 /api/cost 原样吐给前端，前端只做展示。
//
// 三条纪律：
//   1. 记账失败绝不能影响剪辑 —— 全部 try/catch 吞掉，最坏是没有花费显示。
//   2. 一律按**标价**算，不折每月免费额度（宁可高估，不让用户以为免费）。
//   3. 单价来自 rules.json 的 pricing 段，不在代码里硬编码。
import fs from "node:fs";
import path from "node:path";

const FALLBACK_PRICE = {
  llm: { input: 0.8, output: 2, cachedInput: 0.16 },
  asr: { perSec: 0.00008, freeSecPerMonth: 36000 },
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function priceOf(rules) {
  const p = (rules && rules.pricing) || {};
  return {
    llm: {
      input: num(p.llm?.input, FALLBACK_PRICE.llm.input),
      output: num(p.llm?.output, FALLBACK_PRICE.llm.output),
      cachedInput: num(p.llm?.cachedInput, FALLBACK_PRICE.llm.cachedInput),
    },
    asr: {
      perSec: num(p.asr?.perSec, FALLBACK_PRICE.asr.perSec),
      freeSecPerMonth: num(p.asr?.freeSecPerMonth, FALLBACK_PRICE.asr.freeSecPerMonth),
    },
  };
}

const llmCostOf = (row, pr) =>
  ((row.in - row.cache) * pr.llm.input + row.cache * pr.llm.cachedInput + row.out * pr.llm.output) / 1e6;

/** 从 asr_cloud.py 的 stdout 里抓 ASR_USAGE 账单行 */
export function parseAsrUsage(stdout) {
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const i = line.indexOf("ASR_USAGE ");
    if (i < 0) continue;
    try {
      const j = JSON.parse(line.slice(i + 10));
      if (Number.isFinite(Number(j.seconds))) out.push(j);
    } catch { /* 账单行坏了就当没有 */ }
  }
  return out;
}

export function beginUsage(epDir, { rules, model, version, mode } = {}) {
  const work = path.join(epDir, "work");
  const jsonl = path.join(work, "llm-usage.jsonl");
  const st = {
    epDir, jsonl, model, version, mode,
    price: priceOf(rules),
    asr: [],
    startedAt: new Date().toISOString(),
    done: false,
  };
  try {
    fs.mkdirSync(work, { recursive: true });
    try { fs.unlinkSync(jsonl); } catch { /* 本来就没有 */ }
  } catch { /* 删不掉就往后追加，下面读时会按开始时间过滤 */ }
  // llm.mjs 只认这个变量。必须覆盖：这是本轮自己的账本，不能和上一轮混在一起。
  process.env.XUNJIAN_USAGE_LOG = jsonl;
  return st;
}

export function noteAsr(st, stdout) {
  try {
    for (const j of parseAsrUsage(stdout)) st.asr.push(j);
  } catch { /* 忽略 */ }
}

/** 汇总落盘。可重复调用（进程收尾兜底会再调一次）。 */
export function finishUsage(st, extra = {}) {
  if (!st || st.done) return null;
  st.done = true;
  let llm = [];
  try {
    const rows = fs.readFileSync(st.jsonl, "utf8").trim().split(/\r?\n/).filter(Boolean).map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);
    const by = new Map();
    for (const r of rows) {
      if (!r || !r.ts || r.ts < st.startedAt) continue;   // 只算本轮（防 rmSync 失败时混进上一轮）
      const k = r.tag || "?";
      const acc = by.get(k) || { tag: k, calls: 0, in: 0, out: 0, cache: 0 };
      acc.calls++;
      acc.in += num(r.in, 0);
      acc.out += num(r.out, 0);
      acc.cache += num(r.cacheRead, 0);
      by.set(k, acc);
    }
    llm = [...by.values()].map((r) => ({ ...r, cost: +llmCostOf(r, st.price).toFixed(6) }));
  } catch { /* 没有账本 = 这一轮没调模型 */ }

  // 同一份音频被转两次时（原片 + 成片）两笔都算上
  const asr = st.asr.map((a) => ({
    seconds: +num(a.seconds, 0).toFixed(2),
    provider: a.provider || "cloud",
    model: a.model || "paraformer-v2",
    cost: +(num(a.seconds, 0) * st.price.asr.perSec).toFixed(6),
  }));
  const llmCost = +llm.reduce((a, r) => a + r.cost, 0).toFixed(6);
  const asrCost = +asr.reduce((a, r) => a + r.cost, 0).toFixed(6);
  const out = {
    ok: true,
    at: new Date().toISOString(),
    model: st.model || "",
    version: st.version || 1,
    mode: st.mode || "cut",
    llm, asr,
    llmCost, asrCost,
    total: +(llmCost + asrCost).toFixed(6),
    pricing: st.price,
    partial: !!extra.partial,
  };
  try {
    fs.writeFileSync(path.join(st.epDir, "work/run-usage.json"), JSON.stringify(out, null, 1));
  } catch { /* 落盘失败不影响返回 */ }
  return out;
}

/** 给 run.mjs 用的收尾兜底：任何 exit 都要把已花的钱记下来 */
export function guardExit(st, extra = {}) {
  process.on("exit", () => {
    try { finishUsage(st, { ...extra, partial: true }); } catch { /* 忽略 */ }
  });
}
