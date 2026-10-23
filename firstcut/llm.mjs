// LLM 调用层 —— 提示词走 stdin，JSON 结果走 stdout。
// 用法: node firstcut/llm.mjs < 提示词.txt
//
// 为什么是「同步子进程」而不是直接在主流程里 await：
//   run.mjs 全文是同步的（0 个顶层 await），adjudicate() 在四处被同步调用。
//   改成异步会传染整条主流程（包括剪辑区间计算、落盘顺序），风险远大于收益。
//   子进程内部异步无妨，主流程拿到的仍是字符串。
//
// 默认后端：阿里云百炼 OpenAI 兼容端点 + qwen-plus。
// 与 ASR 共用同一个 DASHSCOPE_API_KEY —— 开源用户只需配一行。
// 想切回 DeepSeek / 其它厂商：设 XUNJIAN_LLM_BASE 与 XUNJIAN_LLM_MODEL 即可，
// 代码不用动（见 firstcut/rules.json 的 llm 段）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 独立可用：被 run.mjs spawn 时已继承好环境变量，但单独调用（调试/脚本）也要能读到 .env。
(() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "..", ".env"), path.join(process.cwd(), ".env")]) {
    if (!fs.existsSync(p)) continue;
    try {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith("#") || !s.includes("=")) continue;
        const i = s.indexOf("=");
        const k = s.slice(0, i).trim();
        let v = s.slice(i + 1).trim();
        if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
        if (k && process.env[k] === undefined) process.env[k] = v;
      }
    } catch { /* 忽略 */ }
    break;
  }
})();

const BASE = (process.env.XUNJIAN_LLM_BASE || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const MODEL = process.env.XUNJIAN_LLM_MODEL || "qwen-plus";
const TIMEOUT_MS = Number(process.env.XUNJIAN_LLM_TIMEOUT_MS || 900000);
const MAX_TOKENS = Number(process.env.XUNJIAN_LLM_MAX_TOKENS || 8192);
const RETRIES = Number(process.env.XUNJIAN_LLM_RETRIES || 3);

function keyCandidates() {
  const list = [
    ["DASHSCOPE_API_KEY", process.env.DASHSCOPE_API_KEY],
    ["XUNJIAN_LLM_KEY", process.env.XUNJIAN_LLM_KEY],
    ["OPENAI_API_KEY", process.env.OPENAI_API_KEY],
  ];
  return list.filter(([, v]) => v && String(v).trim());
}

function die(msg) {
  process.stderr.write("✗ llm: " + msg + "\n");
  process.exit(2);
}

const readStdin = () => new Promise((res) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { buf += c; });
  process.stdin.on("end", () => res(buf));
});

// 400 时按字段名做降级：某些模型/版本不认 enable_thinking 或 response_format，
// 直接整条失败会导致「裁决静默回退算法」，比降级更糟。
function stripField(body, field) {
  const b = { ...body };
  delete b[field];
  return b;
}

async function once(prompt, key, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const txt = await r.text();
    return { status: r.status, txt };
  } finally {
    clearTimeout(timer);
  }
}

async function call(prompt) {
  const cands = keyCandidates();
  if (!cands.length) {
    die("缺少 API Key。请在项目根目录 .env 写 DASHSCOPE_API_KEY=sk-xxx\n"
      + "  申请: https://bailian.console.aliyun.com/ （需阿里云实名认证）");
  }
  const key = String(cands[0][1]).trim();

  let body = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    // 裁决要可复现：temperature=0 保证同一输入同一结论（回归对比才有意义）
    temperature: 0,
    max_tokens: MAX_TOKENS,
    stream: false,
    // qwen3 系列默认可能开思考：(a) 思考模式只支持流式，非流式调用会报错；
    // (b) 输出 token 翻几倍；(c) 思考内容会污染 JSON。必须显式关。
    enable_thinking: false,
    // 强约束结构化输出。前提：提示词里必须出现 "json" 字样（现有三份都写了"只输出 JSON"）。
    response_format: { type: "json_object" },
  };

  let lastErr = "";
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    let r;
    try {
      r = await once(prompt, key, body);
    } catch (e) {
      lastErr = e.name === "AbortError" ? `超时 ${TIMEOUT_MS}ms` : `${e.name}: ${e.message}`;
      await sleep(1500 * attempt);
      continue;
    }

    if (r.status === 200) {
      let j;
      try { j = JSON.parse(r.txt); } catch { lastErr = "响应不是 JSON: " + r.txt.slice(0, 200); await sleep(800); continue; }
      const content = j?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        lastErr = "content 为空: " + r.txt.slice(0, 200);
        await sleep(800);
        continue;
      }
      logUsage(j?.usage, cands[0][0]);
      return content;
    }

    // 400/422：字段不被识别 → 逐个摘掉再试（只降级一次，不无限重试）
    if (r.status === 400 || r.status === 422) {
      const low = r.txt.toLowerCase();
      if (body.enable_thinking !== undefined && /enable_thinking|thinking/.test(low)) {
        process.stderr.write("ℹ️ llm: 该模型不接受 enable_thinking，已降级重试\n");
        body = stripField(body, "enable_thinking");
        attempt--;   // 降级不算一次业务重试
        continue;
      }
      if (body.response_format !== undefined && /response_format|json/.test(low)) {
        process.stderr.write("ℹ️ llm: 该模型不接受 response_format，已降级重试\n");
        body = stripField(body, "response_format");
        attempt--;
        continue;
      }
      lastErr = `HTTP 400: ${r.txt.slice(0, 300)}`;
      break;   // 其它 400 是请求本身有问题，重试无意义
    }

    // 429 限流 / 5xx 服务端 / 401 之外的其它 → 指数退避
    lastErr = `HTTP ${r.status}: ${r.txt.slice(0, 300)}`;
    if (r.status === 401 || r.status === 403) break;   // 鉴权问题重试无用
    await sleep(1200 * attempt);
  }
  die(`调用失败（${MODEL}）: ${lastErr}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logUsage(usage, keyName) {
  const p = process.env.XUNJIAN_USAGE_LOG;
  if (!p || !usage) return;
  try {
    const row = {
      ts: new Date().toISOString(),
      model: MODEL,
      key: keyName,
      in: usage.prompt_tokens ?? null,
      out: usage.completion_tokens ?? null,
      cacheRead: usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0,
      tag: process.env.XUNJIAN_USAGE_TAG || "",
    };
    fs.appendFileSync(p, JSON.stringify(row) + "\n");
  } catch { /* 记账失败不影响主流程 */ }
}

const prompt = await readStdin();
if (!prompt.trim()) die("stdin 为空（应传入提示词）");
const out = await call(prompt);
// 只把模型内容写到 stdout：run.mjs 会从第一个 { 到最后一个 } 截取 JSON
process.stdout.write(out);
