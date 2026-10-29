// 初剪引擎 —— 原片进，带动效的初剪工程出
// 用法: node firstcut/run.mjs <原片.mp4> [--name 工程名] [--speed 1.2] [--no-ai] [--no-retake] [--retake-sim 0.8] [--cut-only]
//   --cut-only: 只跑剪辑层（探测 → 气口 → 四处剪点 → 剪切转码），出 cam-*.mp4 就退出，
//               跳过成片转写/错字纠错/字幕卡/AI 初剪/预览页。用于"只验收剪辑效果"的迭代。
// 流程: 探测(含旋转) → 剪气口 → 剪重说口误 → 提速 → 响度归一 → 转写字幕 → AI 初剪(可选) → 生成预览 → 去编辑器定剪
// 参数真源: firstcut/rules.json（覆盖优先级 CLI > 环境变量 XUNJIAN_* > rules.json > 内置默认）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectRetakes, detectStutters, detectFillers, findTier2, subtractRanges, retakeSuffixOk } from "./retake.mjs";
import { clipReviewItems } from "./review-clip.mjs";
import { resolveNoteDirectives } from "./note-directive.mjs";
import { homeOf } from "./home.mjs";
import { buildCutFilter } from "./cutfilters.mjs";

const ROOT = process.cwd();
// 程序目录（ROOT）会被整体替换，工程数据在 HOME；两者在源码仓库里是同一个目录
const HOME = homeOf(ROOT);

// ── 零依赖 .env 加载（必须在读取任何 process.env 之前执行）──
// 项目原本没有 dotenv 机制：用户按 README 写了 .env 也不会生效，表现为"配了 key 还说没配"。
// 规则：已存在的同名环境变量优先（不覆盖用户在 shell 里显式设置的值）。
(() => {
  const p = path.join(HOME, ".env");
  if (!fs.existsSync(p)) return;
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
  } catch (e) {
    console.error(`  ⚠️ .env 解析失败（已忽略）: ${e.message}`);
  }
})();

const FFMPEG = process.env.XUNJIAN_FFMPEG || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(?=[^/\\]*$)/, "ffprobe");

// uv 兜底解析：从某些 shell（CI、IDE 内置终端、非登录 shell）启动时 PATH 里没有 ~/.local/bin，
// 而 uv 默认就装在那里 —— 此时 spawnSync("uv") 会 ENOENT，表现为**整条 ASR 静默失败**
// （日志只留一句"⚠️ 转写失败"、成片没字幕，看起来像模型下载问题，极难排查）。
// 这里显式去找常见安装位置，找到就用绝对路径。
const UV = (() => {
  if (process.env.XUNJIAN_UV) return process.env.XUNJIAN_UV;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const cands = [path.join(home, ".local", "bin", "uv.exe"), path.join(home, ".local", "bin", "uv")];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return "uv";   // 最后回退 PATH（找不到时由调用方打印可读错误）
})();
// LLM 调用层：默认走阿里云百炼 OpenAI 兼容端点 + qwen-plus，
// 与云端 ASR 共用同一个 DASHSCOPE_API_KEY —— 开源用户只需配一行。
// 想换厂商：设 XUNJIAN_LLM_BASE / XUNJIAN_LLM_MODEL 或用 rules.llm，代码不用动。
const LLM_JS = path.join(ROOT, "firstcut", "llm.mjs");

// ── rules.json：全流程参数真源 ──
// 覆盖优先级: CLI > 环境变量 XUNJIAN_* > rules.json > 内置默认(下面这份)。
// 缺文件/缺字段一律回落到内置默认,不报错退出(旧环境零改动可用)。
const DEFAULT_RULES = {
  silence: { noiseOffsetDb: -6, noiseClampDb: [-45, -25], noiseFallbackDb: -30, minSilenceSec: 0.35, edgePadSec: 0.1, minSilenceRatio: 0.05, relaxStepDb: 3, relaxMaxTries: 4, keepGapSec: 0.2, minSpeechTotalSec: 1.0 },
  segment: { minKeptSec: 0.25, pauseMinSec: 0.05, edgeFragMinRealSec: 0.8, snap: { fineSilenceSec: 0.15, searchNextWithinSec: 1.5, tailProtectSec: 0.06, insideToleranceSec: 0.05, fineTailPadSec: 0.02, speechGuardSec: 0.08 }, edgeFadeSec: 0.03 },
  retake: { sim: 0.8, recallSim: 0.6, recallGapSec: 20, recallLookAhead: 8, maxGapSec: 8, minChars: 5, lookAheadSegs: 3, prefixSimMin: 0.85, lcpMin: 6, lcpGapSec: 2.0, dupSim: 0.9, dupGapSec: 20, breatheSec: 0.05, minCutSec: 0.3, mergeGapSec: 0.1, minRemainSec: 0.2 },
  stutter: { longWordSec: 1.0, cpsThreshold: 3.5, minSegSec: 1.5, minChars: 4, minCutSec: 0.5, minRepeatChars: 5, maxHeadChars: 12, innerMinChars: 14, innerMaxCutSec: 3.0, tailMinChars: 8, leadRestart: true, leadMaxChars: 6, leadPauseSec: 0.30, leadMaxCutSec: 2.5 },
  filler: { enabled: true, tier1: ["嗯", "呃", "唉", "哎", "哎呀", "哦", "噢"], tier2: [], tier1Cut: true, tier2Llm: true, standalonePauseSec: 0.12, maxDurSec: 0.6, minCutSec: 0.15 },
  corrections: { enabled: false, maxDeltaRatio: 0.3, maxEditPerLine: 8, pinyinSimMin: 0.5, chunkSize: 6 },
  asr: { provider: "auto", model: "small", beamSize: 5, vadMinSilenceMs: 300, language: "zh", hotwordsOffForRaw: true, chunkSec: 20.0, chunkOverlapSec: 0.5, coverageGapSec: 2.5, chunkRetry: 3, speechRms: 0.012, minCharsPerSec: 1.2, densityMinSpanSec: 2.5, refineChunkSec: 6.0, t2s: true, cloud: { model: "paraformer-v2", pricePerSec: 0.00008, onFail: "abort", retries: 3 } },
  caption: { maxCharsPerLine: 14, spaceBreakMinChars: 8, layout: "sentence", stripPunct: "", fixes: [] },
  encode: { speed: 1.2, crf: 18, preset: "fast", gopFrames: 15, audioBitrate: "192k", loudnorm: "I=-14:TP=-1.5:LRA=11" },
  llm: { enabled: true, model: "qwen-plus", maxTokens: 8192, thinking: false, timeoutMs: 900000 },
  redundancy: { enabled: true, maxRatio: 0.35, maxRun: 6, maxSegSec: 20, slipMaxChars: 16, paraphraseGapSec: 25, paraphraseMinChars: 8, paraphraseMinSec: 1.5, offtopicHeadSegs: 2, offtopicTailSegs: 2 },
  arbiter: { enabled: true, kinds: ["caption-break"], model: "qwen-plus", fallbackToAlgo: true, maxDeltaRatio: 0.3, minConfidence: 0.6, onUnknownId: "ignore", onMissingId: "algo" },
};
const deepMerge = (base, over) => {
  if (Array.isArray(over) || over === null || typeof over !== "object") return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (base && typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k]))
      ? deepMerge(base[k], v) : v;
  }
  return out;
};
const RULES_PATH = process.env.XUNJIAN_RULES || path.join(ROOT, "firstcut", "rules.json");
let R = DEFAULT_RULES;
try {
  R = deepMerge(DEFAULT_RULES, JSON.parse(fs.readFileSync(RULES_PATH, "utf8")));
} catch (e) {
  console.error(`  ⚠️ 未读到 rules.json(${RULES_PATH})，使用内置默认: ${e.message}`);
}

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
if (!input || !fs.existsSync(input)) {
  console.error("用法: node firstcut/run.mjs <原片.mp4> [--name 工程名] [--speed 1.2] [--no-ai]");
  process.exit(1);
}
const getOpt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const NAME = getOpt("--name", path.basename(input).replace(/\.[^.]+$/, "").replace(/[^\w一-龥-]/g, "-"));
const SPEED = Number(getOpt("--speed", String(R.encode.speed)));
const NO_AI = args.includes("--no-ai");
const NO_RETAKE = args.includes("--no-retake");
const NO_AICUT = args.includes("--no-aicut");   // 只跳过 AI 初剪，保留断行裁决（P1 单独测试用）
const CUT_ONLY = args.includes("--cut-only");   // 只跑剪辑层，出成片即止（不做字幕/初剪/预览页）
// 「AI 剪辑」重跑：服务端先把旧版冻结成 vN，再传这个号让本次结果登记为第 N 版
const REBASE_TO = Number(process.env.XUNJIAN_REBASE_TO || 0);
const RETAKE_SIM_OPT = getOpt("--retake-sim", null);   // 未显式给出时用 rules.retake.sim
const EP = path.join(HOME, "episodes", NAME);
const step = (m) => console.log("\n▸ " + m);
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 64e6, ...opts });
const die = (m) => { console.error("✗ " + m); process.exit(1); };
// 转写子进程环境:离线/代理环境下 huggingface_hub 会去校验模型 etag,走代理常被 502 拦掉,
// 导致 ASR 整链静默降级为"无字幕"(且误导性提示"需安装 uv")。这里给 uv 子进程兜底默认:
// 走 hf-mirror 镜像 + 关 xet/软链接。用户若已显式设置同名变量则不覆盖。
const ASR_ENV = {
  ...process.env,
  HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
  HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET || "1",
  HF_HUB_DISABLE_SYMLINKS: process.env.HF_HUB_DISABLE_SYMLINKS || "1",
  // uv 每次 run 默认会去索引校验依赖，本机走代理经常 502/长时间挂住（实测 C0793 卡 19 分钟无进展）。
  // 依赖（faster-whisper / av / jieba / zhconv）首次跑过后已在 uv 缓存里，默认离线即可；
  // 换机器首次使用请设 UV_OFFLINE=0 让 uv 联网装包。
  UV_OFFLINE: process.env.UV_OFFLINE || "1",
  // 模型已在本地缓存时仍会走一次 hub API（etag 校验），本机代理 502 会让整条转写失败
  // （实测 v7b-C0793：httpx2.ProxyError: 502 → 无字幕/无剪点）。默认直接禁止 hub 联网，
  // 失败时 runAsr 会自动联网重试一次（首次使用/换机器场景）。
  HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || "1",
};
// ASR 调用统一走这里:失败时把 stderr 尾巴打进日志,避免"转写不可用"变成无信息的黑洞。
const asrFail = (r) => {
  const txt = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ");
  if (txt) return txt;
  // spawnSync 自身失败（ENOENT/超时）时 stderr 是空的，真正的错因在 r.error —— 不打印出来
  // 就会变成一句无信息的"转写失败"，让人误以为是模型/网络问题。
  if (r.error) return `${r.error.code || r.error.name}: ${r.error.message}`;
  return `exit=${r.status}${r.signal ? " signal=" + r.signal : ""}（无输出）`;
};
// 转写统一入口：默认离线跑；命中网络/代理类错误时自动联网重试一次（模型未缓存的新机器也能过）
const runAsr = (argv, extraEnv = {}) => {
  let r = run(UV, argv, { env: { ...ASR_ENV, ...extraEnv } });
  const msg = `${r.stderr || ""}${r.stdout || ""}`;
  if (r.status !== 0 && /502|ProxyError|Connection|ConnectError|timed out|offline|couldn't connect/i.test(msg)) {
    console.log("  ↻ 转写遇网络/代理错误，改用联网模式重试一次");
    r = run(UV, argv, { env: { ...ASR_ENV, ...extraEnv, HF_HUB_OFFLINE: "0", UV_OFFLINE: "0" } });
  }
  return r;
};

// ── ASR provider 调度 ────────────────────────────────────────────────────────
// cloud: paraformer-v2 文件转写（真实字级时间戳，无需本地模型）
// local: faster-whisper（离线兜底；开源用户没有 key 时仍能跑）
// auto : 有 DASHSCOPE_API_KEY 就走云端，否则本地
const ASR_PROVIDER = (() => {
  const v = String(process.env.XUNJIAN_ASR_PROVIDER || (R.asr && R.asr.provider) || "auto").toLowerCase();
  if (v === "cloud" || v === "local") return v;
  return (process.env.DASHSCOPE_API_KEY || "").trim() ? "cloud" : "local";
})();
// 云端转写只依赖 dashscope + requests。若用户已装好（或指定了解释器）就直接跑，
// 否则交给 uv 托管（与 local 一致的"零手动安装"体验）。
const PY_DIRECT = (process.env.XUNJIAN_PYTHON || "").trim();
const runPy = (argv, extraEnv = {}) => {
  if (PY_DIRECT) return run(PY_DIRECT, argv, { env: { ...process.env, ...extraEnv } });
  // 注意：不能带 UV_OFFLINE=1。它是给 whisper 那颗"依赖已在缓存里"的场景兜底的，
  // 而云端首次跑必须联网装 dashscope/requests（实测首次 ~25s，之后命中缓存 ~1s）。
  const env = { ...ASR_ENV, ...extraEnv };
  delete env.UV_OFFLINE;
  env.HF_HUB_OFFLINE = "0";
  return run(UV, ["run", "--with", "dashscope", "--with", "requests", "python", ...argv], { env });
};

/** 原片转写（结构用途：重说/卡壳/语气词判据的输入）→ 句段 IR 落盘 */
const transcribeRaw = (wav, segsOut, extraEnv = {}) => {
  if (ASR_PROVIDER === "cloud") {
    return runPy([path.join(ROOT, "firstcut/asr_cloud.py"), wav, segsOut], extraEnv);
  }
  const capsOut = path.join(EP, "work/raw-caps.json");
  return runAsr(["run", "--with", "faster-whisper", "--with", "av<14", "--with", "jieba", "--with", "zhconv", "python",
    path.join(ROOT, "firstcut/asr_and_caps.py"), wav, capsOut,
    process.env.XUNJIAN_WHISPER_MODEL || R.asr.model, segsOut], extraEnv);
};

/** 成片字幕转写。cloud 下复用同一份云端结果走本地断行，不再二次计费。 */
// 字幕断行（replay 模式）需要 numpy 读音频算停顿、jieba 算词边界、zhconv 繁转简；
// 少了 numpy 会静默退化成"只按词边界断行"（日志会打"读不到音频"），断行质量明显下降。
const runCapsPy = (argv, extraEnv = {}) => {
  if (PY_DIRECT) return run(PY_DIRECT, argv, { env: { ...process.env, ...extraEnv } });
  const env = { ...ASR_ENV, ...extraEnv };
  delete env.UV_OFFLINE;
  env.HF_HUB_OFFLINE = "0";
  return run(UV, ["run", "--with", "numpy", "--with", "jieba", "--with", "zhconv", "python", ...argv], { env });
};
const transcribeCaps = (wav, capsOut, segsOut) => {
  if (ASR_PROVIDER === "cloud") {
    const r1 = runPy([path.join(ROOT, "firstcut/asr_cloud.py"), wav, segsOut], {});
    if (r1.status !== 0) return r1;
    // asr_and_caps.py 内建的 replay 入口：从句段 JSON 重建字幕，跳过 whisper。
    return runCapsPy([path.join(ROOT, "firstcut/asr_and_caps.py"), wav, capsOut], { XUNJIAN_BREAK_FROM_SEGS: segsOut });
  }
  return runAsr(["run", "--with", "faster-whisper", "--with", "av<14", "--with", "jieba", "--with", "zhconv", "python",
    path.join(ROOT, "firstcut/asr_and_caps.py"), wav, capsOut], { XUNJIAN_ASR_HOTWORDS: "off" });
};

// ── 统一语义裁决(arbiter)──
// 读 firstcut/arbiter-prompt-<kind>.md,把 payload 填进 {{INPUT}},调 LLM 取 JSON。
// LLM 只给"表态/建议",最终由确定性代码落地;任何失败返回 null,调用方回退算法结果。
const arbiterOk = (kind) => !NO_AI && R.arbiter.enabled && (R.arbiter.kinds || []).includes(kind);
// 「AI 剪辑」重跑时用户填的一句补充要求（可空）。它只作为裁决的额外参考，
// 不改判据、不改输出格式 —— 最终仍由确定性代码落地。
const EXTRA_NOTE = String(process.env.XUNJIAN_EXTRA_NOTE || "").trim();

// ── 补充要求里的"风格词" → 停顿参数的松紧档 ──
// 用户填「再紧凑一点 / 别太碎」这类没有具体句子的要求时，模型无事可做（也改不了判据），
// 但这一档确实能改变结果：收紧边界内缩与最短保留间隙，成片更密；放宽则相反。
// 只动停顿余量，不碰语义判据（重说/冗余那几条仍是宁漏勿错）。
const NOTE_STYLE = (() => {
  if (!EXTRA_NOTE) return null;
  const tight = /(紧凑|再紧|紧一点|多剪|狠一点|剪干净|节奏快|快节奏|拖沓|啰嗦|废话多)/.test(EXTRA_NOTE);
  const loose = /(宽松|别剪太多|少剪|保守|别太碎|留完整|保留完整|别删太多)/.test(EXTRA_NOTE);
  if (tight && !loose) return "tight";
  if (loose && !tight) return "loose";
  return null;
})();
if (NOTE_STYLE) {
  const f = NOTE_STYLE === "tight" ? { pad: 0.6, gap: 0.6 } : { pad: 1.6, gap: 1.6 };
  R.silence.edgePadSec = +(R.silence.edgePadSec * f.pad).toFixed(3);
  R.silence.keepGapSec = +(R.silence.keepGapSec * f.gap).toFixed(3);
  console.log(`  补充要求判定为「${NOTE_STYLE === "tight" ? "更紧凑" : "更宽松"}」→ 边界内缩 ${R.silence.edgePadSec}s · 最短保留间隙 ${R.silence.keepGapSec}s`);
}
// 补充要求解析出的剪点/保护点（首剪为空；「AI 剪辑」重跑才有）
let NOTE_DIR = { cuts: [], keeps: [], log: [], report: { note: "", actions: [], unmatched: [] } };

const adjudicate = (kind, payload) => {
  const pf = path.join(ROOT, `firstcut/arbiter-prompt-${kind}.md`);
  if (!fs.existsSync(pf)) { console.log(`  ⚠️ 缺少 arbiter-prompt-${kind}.md，跳过裁决`); return null; }
  let prompt = fs.readFileSync(pf, "utf8").replaceAll("{{INPUT}}", JSON.stringify(payload));
  // 放在提示词末尾、并明确"不得改变输出格式"，否则模型容易自己发明字段
  if (EXTRA_NOTE) {
    prompt += `\n\n## 用户这次特别要求（仅作参考）\n${EXTRA_NOTE}\n\n`
      + `请把上面这条要求当作额外的判断依据，但仍然**严格按本文档要求的输出格式**返回，不要新增字段或解释。`;
  }
  // 直接 spawn node（不再经 shell 拼命令行）：Windows 上省掉整套引号转义，也避免
  // 用户机器上 claude.cmd 之类的 PATH 依赖。提示词走 stdin，结果走 stdout。
  const env = { ...process.env, XUNJIAN_USAGE_TAG: kind };
  if (R.llm && R.llm.model) env.XUNJIAN_LLM_MODEL = R.llm.model;
  const ax = spawnSync(process.execPath, [LLM_JS], {
    encoding: "utf8", maxBuffer: 64e6, input: prompt, timeout: R.llm.timeoutMs, env,
  });
  const ao = ax.stdout || "";
  if (ax.status !== 0 && !ao.trim()) {
    const why = (ax.stderr || "").trim().split("\n").slice(-2).join(" | ") || ax.error?.message || "无输出";
    console.log(`  ⚠️ ${kind} 裁决调用失败（${why}），回退算法结果`);
    return null;
  }
  try { return JSON.parse(ao.slice(ao.indexOf("{"), ao.lastIndexOf("}") + 1)); }
  catch { console.log(`  ⚠️ ${kind} 裁决解析失败，回退算法结果: ${ao.trim().slice(0, 100)}`); return null; }
};
// 编辑距离(错字纠错的护栏:改动幅度过大视为"改写"而丢弃)
const lev = (a, b) => {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
};

// ── 1. 探测（旋转元数据决定横竖）──
step("探测原片");
const probe = run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries",
  "stream=width,height:stream_side_data=rotation:format=duration", "-of", "json", input]);
if (probe.status !== 0) die("ffprobe 失败，请确认已安装 ffmpeg");
const pj = JSON.parse(probe.stdout);
const st = pj.streams?.[0] || {};
const rot = Math.abs(Number((st.side_data_list || []).find((d) => d.rotation != null)?.rotation || 0));
const vertical = rot === 90 || rot === 270 ? st.width > st.height : st.height > st.width;
const rawDur = Number(pj.format?.duration || 0);
console.log(`  ${st.width}x${st.height} rotation=${rot} → ${vertical ? "竖屏 ✓" : "⚠️ 横屏(编辑器默认竖屏版式,建议竖屏素材)"} · ${rawDur.toFixed(1)}s`);

// ── 审核队列（供剪辑台逐条问用户）──
// 只收「模型表了态、却被确定性护栏推翻」的冲突点；"判据压根没命中"的漏检不进队列，
// 否则队列会被噪音塞满。options 用**区间集合**表达（删一个词 / 删整句 / 删前半），
// 而不是布尔值 —— 重导出时直接按区间从 segs 里减掉即可，不必回头问模型。
const REVIEW = [];
const pushReview = (o) => REVIEW.push({ id: REVIEW.length + 1, default: "keep", priority: 2, ...o });

// ── 2. 剪气口（静音检测 → trim/concat）──
step("检测气口/无声段");
// 噪声门自适应:不同素材整体音量差异极大(直播间素材实测均值可低至 -28dB),
// 固定 -38dB 在低音量素材上几乎测不出静音 → 以实测平均音量再加 noiseOffsetDb 作阈值,
// 并夹在 noiseClampDb 区间;可用 XUNJIAN_NOISE_DB / XUNJIAN_SIL_D / XUNJIAN_PAD 覆盖。
//
// 单靠均值仍会失手:实测「课堂实拍」素材(人声轻 −34.9dB + 连续底噪)下 mean−6=−41dB
// 落在实际停顿电平之下,全片 0 处静音 → 气口一刀未剪。故加一层**反馈式放宽**:
// 先按 mean−6 试,若检出静音总时长不足 minSilenceRatio,每次放宽 relaxStepDb(最多 relaxMaxTries 次),取首次达标者。
// 这三处「全片分析」只吃音频，必须带 -vn 跳过视频解码。
// 实测（1080×1920 59.94、6 核）：30s 素材 silencedetect 全解码 3781ms → 加 -vn 548ms，**6.9×**；
// 而一次剪辑要跑最多 7 遍（音量 1 + 气口 1+4 次放宽 + 切口吸附 1），4K/HEVC 源差距还要大得多。
const vd = run(FFMPEG, ["-i", input, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
const meanDb = Number((/mean_volume:\s*(-?[\d.]+) dB/.exec(vd.stderr || "") || [])[1]);
const [NMIN, NMAX] = R.silence.noiseClampDb;
const baseNoise = Number(process.env.XUNJIAN_NOISE_DB) ||
  (Number.isFinite(meanDb) ? Math.round(Math.max(NMIN, Math.min(NMAX, meanDb + R.silence.noiseOffsetDb))) : R.silence.noiseFallbackDb);
const SIL_D = Number(process.env.XUNJIAN_SIL_D) || R.silence.minSilenceSec;
const PAD = Number(process.env.XUNJIAN_PAD) || R.silence.edgePadSec;
const silLog = (db) => (run(FFMPEG, ["-i", input, "-vn", "-af",
  `silencedetect=noise=${db}dB:d=${SIL_D}`, "-f", "null", "-"]).stderr || "");
const silTotal = (l) => [...l.matchAll(/silence_duration: ([\d.]+)/g)]
  .reduce((a, m) => a + Number(m[1]), 0);
let NOISE = baseNoise, log = silLog(NOISE);
const MIN_SIL = rawDur * R.silence.minSilenceRatio;   // 期望至少这么多时长为停顿,否则判定门限过严
if (!Number(process.env.XUNJIAN_NOISE_DB) && silTotal(log) < MIN_SIL) {
  for (let k = 1; k <= R.silence.relaxMaxTries; k++) {
    const cand = baseNoise + R.silence.relaxStepDb * k;      // 抬高门限(更宽松)才能检出更多停顿
    const l2 = silLog(cand);
    if (silTotal(l2) >= MIN_SIL) {
      console.log(`  噪声门放宽 ${baseNoise}→${cand}dB(原门限仅检出 ${silTotal(log).toFixed(1)}s 停顿 < 全片 ${(R.silence.minSilenceRatio * 100).toFixed(0)}%)`);
      NOISE = cand; log = l2; break;
    }
  }
}
console.log(`  噪声门 ${NOISE}dB(原片均值 ${Number.isFinite(meanDb) ? meanDb.toFixed(1) : "?"}dB) · 最短静音 ${SIL_D}s · 边界内缩 ${PAD}s`);
const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
let segs = [], cur = 0;
for (let i = 0; i < starts.length; i++) {
  const s0 = Math.min(starts[i] + PAD, rawDur), e0 = Math.max((ends[i] ?? rawDur) - PAD, 0);
  if (s0 - cur > R.silence.keepGapSec) segs.push([cur, s0]);
  cur = Math.max(cur, e0);
}
if (rawDur - cur > R.silence.keepGapSec) segs.push([cur, rawDur]);
if (!segs.length || segs.reduce((a, [s, e]) => a + e - s, 0) < R.silence.minSpeechTotalSec) { segs = [[0, rawDur]]; console.log("  几乎无有效人声分段，保留全片"); }
else console.log(`  保留 ${segs.length} 段，剪掉 ${(rawDur - segs.reduce((a, [s, e]) => a + e - s, 0)).toFixed(1)}s 气口`);

// ── 首尾孤立短碎片过滤 ──
// 实测：C0793 片头只留下 [7.33-7.63] 0.30s、[16.56-16.93] 0.37s 两个碎片（之后到 38.27s 才是正文）；
// C0777 片头同样有 [18.53-18.79] 0.26s、[19.11-19.41] 0.30s —— 听感就是"开头一直有杂音"。
// 判据不靠绝对时长，而是「落在正文范围之外」：找到第一条/最后一条 ≥ minRealSec 的段，
// 它之前（片尾则是之后）的短段一律丢弃。正文中间出现的短句（"对。"）不受影响。
const dropEdgeFrags = (list) => {
  const MINREAL = Number(process.env.XUNJIAN_MINREAL ?? R.segment.edgeFragMinRealSec ?? 0.8);
  const isReal = ([s, e]) => e - s >= MINREAL;
  const fi = list.findIndex(isReal);
  let li = -1;
  for (let i = list.length - 1; i >= 0; i--) if (isReal(list[i])) { li = i; break; }
  if (fi < 0 || li < 0) return { list, dropped: [] };
  const dropped = [], kept = [];
  list.forEach((sg, i) => {
    if ((i < fi || i > li) && !isReal(sg)) dropped.push(sg);
    else kept.push(sg);
  });
  return { list: kept, dropped };
};
const _ef = dropEdgeFrags(segs);
if (_ef.dropped.length) {
  segs = _ef.list;
  console.log(`  丢弃首尾孤立短碎片 ${_ef.dropped.length} 处（判为碰麦/呼吸/桌面噪声）：` +
    _ef.dropped.map(([s, e]) => `[${s.toFixed(2)}-${e.toFixed(2)}]`).join(" "));
}

// ── 2.5 剪重说口误（转写原片 → 紧挨着的高相似句 = 说错重来，剪前一遍保后一遍）──
let cutsGlobal = [];   // 供 cut-plan.json 落盘（重说/卡壳的实际切口）
let RAW_SEGS = [];     // 原片逐句转写，供剪后「孤立残句」过滤复用
let DUP_HEAD = new Set();   // 「重来版」的第一句下标：它们是被重说的最终版本，不许删
let FINE_SEGS = [];    // 段级复核转写（上下文更短，短词更全）——只用于语气词候选
if (!NO_RETAKE) {
  step("检测重说口误(转写原片,约1-2分钟)");
  fs.mkdirSync(path.join(EP, "work"), { recursive: true });
  const rawWav = path.join(EP, "work/raw-asr.wav");
  const rawCaps = path.join(EP, "work/raw-caps.json");
  const rawSegsPath = path.join(EP, "work/raw-segs.json");
  run(FFMPEG, ["-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", rawWav]);
  // 这一步必须关掉领域热词提示:注入提示会让 whisper 把整片解码成一段连续文本、
  // VAD 分段全被合并(13 段→1 段),下游重说/卡壳检测就会空转。热词只用于成片字幕那一步。
  // 云端模式下这个顾虑不存在（paraformer 不做 initial_prompt 注入），参数保留只为兼容 local。
  const ra = transcribeRaw(rawWav, rawSegsPath, { XUNJIAN_ASR_HOTWORDS: "off" });
  if (ra.status !== 0) console.log(`  ⚠️ 原片转写失败: ${asrFail(ra)}`);
  if (ra.status === 0 && fs.existsSync(rawSegsPath)) {
    const rawSegs = RAW_SEGS = JSON.parse(fs.readFileSync(rawSegsPath, "utf8"));
    // 段级复核结果（asr_and_caps 的 XUNJIAN_SEGCHECK）：文本更完整，专门用来找被 20s 分块吞掉的语气词。
    try {
      const fp = path.join(EP, "work/raw-segs-fine.json");
      if (fs.existsSync(fp)) FINE_SEGS = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (e) { console.log(`  ⚠️ 段级复核结果不可读: ${e.message}`); }
    // ── 补充要求（「AI 剪辑」弹窗里那句）→ 剪点 ──
    // 只把这句话追加到裁决提示词末尾是无效的：四类裁决只能对"已经检出的候选"表态，
    // 用户点名要删的句子若不在候选集里，模型再听话也剪不动（2026-10-23 实测：
    // 填「删掉『有人能够在1个小时之内记住几百个』」→ 成片一字未变）。
    // 所以这里单独解析成时间区间，直接并入剪切表。
    if (EXTRA_NOTE) {
      step("执行补充要求");
      NOTE_DIR = resolveNoteDirectives({
        note: EXTRA_NOTE, segs: rawSegs, dur: rawDur,
        adjudicate: arbiterOk("note-directive") ? adjudicate : null,
      });
      for (const l of NOTE_DIR.log) console.log("  " + l);
      const cutSec = NOTE_DIR.cuts.reduce((n, [a, b]) => n + (b - a), 0);
      if (!NOTE_DIR.cuts.length && NOTE_STYLE) {
        console.log(`  本条是风格类要求（${NOTE_STYLE === "tight" ? "更紧凑" : "更宽松"}），已通过停顿参数生效，不需要具体剪点`);
      } else if (!NOTE_DIR.cuts.length) {
        console.log(`  ⚠️ 补充要求没定位到可剪片段，本次未生效：「${EXTRA_NOTE.slice(0, 60)}」`);
        if (NOTE_DIR.report.unmatched.length)
          console.log(`     未匹配：${NOTE_DIR.report.unmatched.map((x) => `「${x}」`).join(" ")}`);
      } else {
        console.log(`  要求命中 ${NOTE_DIR.cuts.length} 段，共 -${cutSec.toFixed(1)}s` +
          (NOTE_DIR.keeps.length ? `，另保护 ${NOTE_DIR.keeps.length} 处` : ""));
      }
      try {
        fs.mkdirSync(path.join(EP, "work"), { recursive: true });
        fs.writeFileSync(path.join(EP, "work/note-directives.json"),
          JSON.stringify({ note: EXTRA_NOTE, style: NOTE_STYLE, ...NOTE_DIR }, null, 1));
      } catch {}
    }
    // ── 重说(③):召回优先出候选 → 若启用 LLM 裁决,交 LLM 判"是否真重说"(防误剪) ──
    const rtOpts = { ...R.retake };
    let rt;
    if (RETAKE_SIM_OPT != null) {
      rt = detectRetakes(rawSegs, { ...rtOpts, sim: Number(RETAKE_SIM_OPT) });   // 用户显式指定阈值 → 不做 LLM 裁决
    } else if (arbiterOk("retake-verdict")) {
      rt = detectRetakes(rawSegs, {
        ...rtOpts, sim: rtOpts.recallSim ?? rtOpts.sim,
        maxGapSec: rtOpts.recallGapSec ?? rtOpts.maxGapSec,
        lookAheadSegs: rtOpts.recallLookAhead ?? rtOpts.lookAheadSegs,
      });   // 放宽阈值/窗口提召回
      const cand = rt.report;
      if (cand.length) {
        step(`重说裁决（${R.arbiter.model}，${cand.length} 组候选）`);
        const v = adjudicate("retake", { pairs: cand.map((r, i) => ({ id: i, cut: r.cut, kept: r.kept, sim: r.sim, gap: r.gap })) });
        if (v && Array.isArray(v.verdicts)) {
          const cutIds = new Set(v.verdicts.filter((x) => x && x.verdict === "cut-first").map((x) => x.id));
          let picked = cand.filter((_, i) => cutIds.has(i));
          // ── 确定性命中：LCP 开头连续一致 ≥lcpMin 字（间隔 ≤lcpGapSec）/ 近乎逐字重复（sim ≥dupSim）──
          // 这两类都是高精度判据（实测三素材零误报），不需要 LLM 复核即可直接采纳，
          // 专门用来兜住"相似度判据漏检"与"剪/留文本几乎一样、LLM 反而判为刻意重复"两种失效。
          const detHits = cand.filter((r) => r.kind === "lcp" || r.kind === "dup");
          const pickedSet = new Set(picked);
          for (const r of detHits) if (!pickedSet.has(r)) { picked.push(r); pickedSet.add(r); }
          if (detHits.length) console.log(`  ✓ 确定性命中 ${detHits.length} 组（LCP/逐字重复），直接采纳`);
          // ── 换说法护栏（确定性）：保留文本是剪除文本的真后缀 → 前一遍更完整，剪掉会丢信息，一律不剪 ──
          // 实测 C0779：剪「我覺得孩子成績不好」/ 留「孩子成績不好」，用户明确要求保留完整那句。
          const _n0 = picked.length;
          picked = picked.filter(retakeSuffixOk);
          if (_n0 !== picked.length)
            console.log(`  ✓ 换说法护栏：拦下 ${_n0 - picked.length} 组「保留是剪除的后缀」的候选（保留更完整的前一遍）`);
          // ── 互斥重说对护栏 ──
          // A=「剪X留Y」与 B=「剪Y留X」是一对互斥判断（说话人前后说了两遍，检测器各指认了对方）。
          // 若两条都采纳，X 和 Y 会被**同时删掉**——整段内容凭空消失（实测 C0793：一次删掉 8.9s 连续语音），
          // 而正确做法永远是"保留后一遍"→ 只采纳**较早**的那条。这里做一次结构化的剔除。
          const nrm = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
          const dropIdx = new Set();
          for (let i = 0; i < picked.length; i++) {
            for (let j = i + 1; j < picked.length; j++) {
              if (nrm(picked[i].cut) === nrm(picked[j].kept) &&
                  nrm(picked[i].kept) === nrm(picked[j].cut)) dropIdx.add(j);
            }
          }
          if (dropIdx.size) {
            picked = picked.filter((_, i) => !dropIdx.has(i));
            console.log(`  ⚠️ 发现 ${dropIdx.size} 组互斥重说(剪A留B / 剪B留A)，已剔除靠后的那条，避免把 A、B 一起删掉`);
          }
          // 单条重说动辄超过 maxSpanSec 基本是误判（正常重说只重复一句话，1~5s）。
          // 不自动改，只在日志里喊一声，方便核对时按图索骥。
          const spanCap = R.retake.maxSpanSec ?? 6;
          const tooLong = picked.filter((r) => r.e - r.s > spanCap);
          if (tooLong.length) console.log(`  ⚠️ 有 ${tooLong.length} 组候选跨度 > ${spanCap}s（最长 ${(Math.max(...tooLong.map((r) => r.e - r.s))).toFixed(1)}s），疑似误判，请重点核对`);
          console.log(`  候选 ${cand.length} 组 → LLM 判定剪 ${picked.length} 组（其余保留，防误剪）`);
          const B = rtOpts.breatheSec ?? 0.05, MC = rtOpts.minCutSec ?? 0.3, MG = rtOpts.mergeGapSec ?? 0.1;
          const cs = picked.map((r) => [Math.max(0, r.s - B), r.e + B]).filter(([a, b]) => b - a >= MC).sort((a, b) => a[0] - b[0]);
          const merged = [];
          for (const c of cs) { const l = merged[merged.length - 1]; if (l && c[0] <= l[1] + MG) l[1] = Math.max(l[1], c[1]); else merged.push(c); }
          rt = { cuts: merged, report: picked };
        } else console.log("  ⚠️ 重说裁决不可用，回退算法结果");
      }
    } else {
      rt = detectRetakes(rawSegs, rtOpts);
    }
    // ── 假起头延伸（确定性）──
    // 同一句说了两遍、后一遍是「重来」的起点时，**前一遍的后半截也要一起删**。
    // 实测 C0779：#44「当你管住了自己的表情」→#45「改善了家庭的环境之后」→#46「孩子大脑也会慢慢地放松」
    // →#47 又重新说「当你管住了自己的表情」。重说检测只删 #44，留下 #45/#46 悬在中间，
    // 成片变成「…孩子大脑也会慢慢地放松／管住了自己的语言」，语义直接断掉。
    // 判据：前 6 字一致且重合度 ≥80%（近逐字重复）、跨度 ≤20s、中间不超过 3 句 → 删 [i, j) 整段，保留 j 起的重来版。
    {
      const _nz = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
      const nt = rawSegs.map((s) => _nz(s.z));
      const extra = [];
      const heads = new Set();
      for (let j = 1; j < rawSegs.length; j++) {
        for (let i = Math.max(0, j - 6); i < j; i++) {
          const a = nt[i], b = nt[j];
          if (!a || !b) continue;
          let lcp = 0;
          while (lcp < a.length && lcp < b.length && a[lcp] === b[lcp]) lcp++;
          if (lcp < 6 || lcp < Math.min(a.length, b.length) * 0.8) continue;
          if (rawSegs[j].s - rawSegs[i].s > 20 || j - i > 4) continue;
          heads.add(j);
          if (j - i >= 2) {
            // 中间的「纯设问短句」不吞（实测 C0777 #11→#13：中间夹着 #12「为什么？」0.39s，
            // 整段删掉后自问自答的设问没了，观众看到的是"结论突然跳出来"）。
            // 用户的验收意见也是「"为什么"属无关联漏剪」——设问是逻辑衔接，不能当重说的一部分删掉。
            const KEEP_Q = /^(为什么|为啥|咋回事|怎么回事|怎么说|什么意思)/;
            const parts = [];
            let cur = rawSegs[i].s, keptQ = 0;
            for (let k = i; k < j; k++) {
              const t = _nz(rawSegs[k].z);
              if (k > i && t.length > 0 && t.length <= 8 && KEEP_Q.test(t)) {
                if (rawSegs[k].s > cur) parts.push([cur, rawSegs[k].s]);
                cur = rawSegs[k].e;
                keptQ++;
              }
            }
            if (rawSegs[j - 1].e > cur) parts.push([cur, rawSegs[j - 1].e]);
            if (!parts.length) parts.push([rawSegs[i].s, rawSegs[j - 1].e]);
            for (const p of parts) extra.push(p);
            console.log(`  ↻ 假起头：删 #${i}–#${j - 1}（${parts.reduce((a, [s2, e2]) => a + (e2 - s2), 0).toFixed(1)}s）` +
              `${keptQ ? `，保留中间 ${keptQ} 处设问（为什么/怎么回事）` : ""}，保留 #${j} 起的重来版「${_nz(rawSegs[j].z).slice(0, 12)}」`);
          }
          break;
        }
      }
      if (extra.length) rt = { cuts: [...rt.cuts, ...extra], report: rt.report };
      DUP_HEAD = heads;
    }
    // 句内"卡壳重说"：两套判据的证据基础不同，按 ASR provider 选。
    //   local(whisper)：长词 + 低 cps（whisper 把停顿吸收进词时长）
    //   cloud(paraformer)：段内假起头（真实字级时间戳下长词判据恒不成立，见 retake.mjs）
    const st = detectStutters(rawSegs, ASR_PROVIDER === "cloud"
      ? {
          mode: "inner-retake",
          minRepeatChars: R.stutter.minRepeatChars, maxHeadChars: R.stutter.maxHeadChars,
          minChars: R.stutter.innerMinChars, minCutSec: R.stutter.minCutSec,
          maxCutSec: R.stutter.innerMaxCutSec, tailMinChars: R.stutter.tailMinChars,
          leadRestart: R.stutter.leadRestart, leadMaxChars: R.stutter.leadMaxChars,
          leadPauseSec: R.stutter.leadPauseSec, leadMaxCutSec: R.stutter.leadMaxCutSec,
        }
      : {
          word: R.stutter.longWordSec, cps: R.stutter.cpsThreshold,
          minSeg: R.stutter.minSegSec, minChars: R.stutter.minChars, minCutSec: R.stutter.minCutSec,
        });
    // ── 语气词(④):tier1 纯白名单直接剪;tier2(这个/那个…)交 LLM 判上下文 ──
    const flOn = !(R.filler && R.filler.enabled === false);
    // 删除后留白：前字尾→切口起点 + 切口终点→后字头。两项都接近 0，说明该词被前后字**夹死**在
    // 连续语流里，删掉它就是把两个字的音直接焊在一起 —— 听感上是一个断点（比留着那个垫词更难受）。
    // 实测 C0779「大脑记忆‖这个‖开关」三处「这个」两侧留白全是 0.000s；而 C0777 那处
    // 「…是这个‖1.31s 静音‖当孩子…」留白 1.31s，删得干净。故判据：留白 <0.10s → 不剪。
    const _nzW = (t) => String(t || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
    const gapAround = (s, e) => {
      let prevEnd = null, nextStart = null;
      for (const sg of RAW_SEGS) {
        for (const [ws, we, word] of sg.w || []) {
          if (!_nzW(word)) continue;
          if (we <= s + 0.02 && (prevEnd == null || we > prevEnd)) prevEnd = we;
          if (ws >= e - 0.02 && (nextStart == null || ws < nextStart)) nextStart = ws;
        }
      }
      return (prevEnd == null ? 99 : s - prevEnd) + (nextStart == null ? 99 : nextStart - e);
    };
    const GAPMIN = R.filler.minGapAfterCutSec ?? 0.10;
    let fl = flOn ? detectFillers(rawSegs, {
      tier1: (R.filler && R.filler.tier1) || undefined,
      standalonePauseSec: R.filler && R.filler.standalonePauseSec,
      maxDurSec: R.filler && R.filler.maxDurSec,
      minCutSec: R.filler && R.filler.minCutSec,
    }) : { cuts: [], report: [] };
    // tier1 同样过留白护栏：真语气词通常独立成说（「…停顿…嗯…」），两侧留白足够；
    // 被前后字夹住的那种删了同样是硬拼。
    if (fl.cuts.length) {
      const keep = [];
      fl.cuts.forEach((c, i) => {
        const g = gapAround(c[0], c[1]);
        if (g < GAPMIN) console.log(`  ✓ 留白护栏：保留「${fl.report[i].cut}」（两侧仅 ${g.toFixed(2)}s，删了是硬拼）`);
        else keep.push(i);
      });
      if (keep.length !== fl.cuts.length) {
        fl = { cuts: keep.map((i) => fl.cuts[i]), report: keep.map((i) => fl.report[i]) };
      }
    }
    if (fl.report.length) console.log(`  检测到语气词(tier1) ${fl.report.length} 处`);
    let f2 = { cuts: [], report: [] };
    if (flOn && R.filler.tier2Llm !== false && arbiterOk("filler-verdict")) {
      // 语气词候选优先用段级复核转写：20s 分块会吞掉「这个/那个」这类短词，
      // 主转写里没有 → 候选都没生成，护栏再严也剪不到（实测 C0779「孩子看到脸上是[这个]比较松弛的」）。
      const cands = findTier2(FINE_SEGS.length ? FINE_SEGS : rawSegs, R.filler.tier2 || [], { standalonePauseSec: R.filler.standalonePauseSec });
      // 细通道只提供「某处有个语气词」的位置；它的短上下文错字多，不能直接给 LLM 当语义依据。
      // 用主通道同一时间的整句回填 lineMain，让 LLM 用主文本判断是垫词还是回指。
      for (const c of cands) {
        const host = RAW_SEGS.find((x) => x.s <= c.s + 0.05 && x.e >= c.e - 0.05)
          || RAW_SEGS.filter((x) => x.s < c.e && x.e > c.s).sort((a, b) => (b.e - b.s) - (a.e - a.s))[0];
        if (host && host.z) c.lineMain = host.z;
      }
      if (cands.length) {
        step(`语气词裁决（${R.arbiter.model}，${cands.length} 个候选）`);
        const v = adjudicate("filler", { items: cands.map((c, i) => ({ id: i, text: c.text, before: c.before, after: c.after, line: c.line, lineMain: c.lineMain || "", prev: c.prev, pos: c.pos, standalone: c.standalone })) });
        if (v && Array.isArray(v.verdicts)) {
          const cutIds = new Set(v.verdicts.filter((x) => x && x.verdict === "cut").map((x) => x.id));
          // 三层确定性护栏（LLM 只表态，剪不剪由这里裁决）：
          // ① 兼实义词落在句段首/尾 → 一律不剪。实测 C0777「就是做样子给孩子来看」的「就是」被判填充词，
          //    成片变成「做样子给孩子来看」，判断句被说成陈述句，语义断了。句段边界不是停顿，不能当"独立成说"的证据。
          // ② 「这个/那个」不再要求独立成说。实测 C0779「而在于家里这个气氛怎么样」前后紧贴，
          //    但确实是垫词；交由 LLM 结合 prev（上一句原文）判断「泛指垫词 / 回指前文具体事物」。
          // ③ 其余 tier2（然后/那么/其实/对吧/是吧）仍要求前后都有停顿。
          const HEAD_TAIL_KEEP = new Set(["就是", "就是說", "然后", "然後", "那么", "那麼", "其实", "其實",
            "所以", "但是", "因为", "因為", "而且", "如果", "对吧", "對吧", "是吧"]);
          const DEMON = new Set(["这个", "這個", "那个", "那個"]);
          const picked = [], blockedHead = [], blockedStick = [], blockedGap = [];
          cands.forEach((c, i) => {
            if (!cutIds.has(i)) return;
            // ④ 留白护栏（对 tier2 全体生效，包括「这个/那个」的短路分支）：
            // 这个词被前后字夹死在连续语流里，删掉就是把两个音直接焊上 —— 是断点，不是利落。
            const g = gapAround(c.s, c.e);
            if (g < GAPMIN) { blockedGap.push({ c, g }); return; }
            if (HEAD_TAIL_KEEP.has(c.text) && (c.pos === "head" || c.pos === "tail")) { blockedHead.push({ c, rule: "headTailKeep" }); return; }
            if (DEMON.has(c.text)) {
              // 「这个/那个 + 泛称名词」是指示结构的一部分（这个事儿/这个情况/这个人），
              // 删掉会缺量词、变成病句（实测「当爸爸这个事儿说到底」→「当爸爸事儿说到底」）。
              if (/^(事儿|事|东西|时候|地方|人|话|问题|情况|样子|感觉|状态)/.test(c.after || "")) {
                blockedHead.push({ c, rule: "demonNoun" }); return;
              }
              picked.push(c); return;
            }
            if (!c.standalone) { blockedStick.push(c); return; }
            picked.push(c);
          });
          if (blockedHead.length)
            console.log(`  ✓ 句首实义护栏：保留 ${blockedHead.length} 个（${blockedHead.map((x) => `「${x.c.text}」`).join("")}在句首/句尾，属句法成分而非垫词）`);
          if (blockedGap.length)
            console.log(`  ✓ 留白护栏：保留 ${blockedGap.length} 个（${blockedGap.map((x) => `「${x.c.text}」两侧 ${x.g.toFixed(2)}s`).join("、")}，删了是硬拼）`);
          if (blockedStick.length)
            console.log(`  ✓ 独立成说护栏：拦下 ${blockedStick.length} 个「与前后文紧贴、非独立成说」的语气词`);
          // ── 落审核队列 ──
          for (const { c, g } of blockedGap) {
            pushReview({
              kind: "filler-gap", priority: 1, s: c.s, e: c.e, text: c.text,
              line: c.lineMain || c.line || "",
              llm: { verdict: "cut", reason: "判为犹豫垫词/口头禅" },
              guard: { rule: "minGapAfterCutSec", value: +g.toFixed(3), limit: GAPMIN },
              question: `删掉「${c.text}」后，前后两字之间只剩 ${g.toFixed(2)}s，听起来会是硬拼。删还是留？`,
              options: [{ label: "删除", cuts: [[c.s, c.e]] }, { label: "保留", cuts: [] }],
            });
          }
          for (const { c, rule } of blockedHead) {
            pushReview({
              kind: rule === "demonNoun" ? "filler-demon" : "filler-syntax",
              priority: 3, s: c.s, e: c.e, text: c.text,
              line: c.lineMain || c.line || "",
              llm: { verdict: "cut", reason: "判为犹豫垫词" },
              guard: { rule, value: String(c.after || "").slice(0, 4), limit: "" },
              question: rule === "demonNoun"
                ? `「${c.text}」后面紧接「${String(c.after || "").slice(0, 4)}」，是在限定对象还是顺口带的？`
                : `「${c.text}」落在句${c.pos === "head" ? "首" : "尾"}，删掉可能让句子缺成分。删还是留？`,
              options: [{ label: "删除", cuts: [[c.s, c.e]] }, { label: "保留", cuts: [] }],
            });
          }
          for (const c of blockedStick) {
            pushReview({
              kind: "filler-stick", priority: 3, s: c.s, e: c.e, text: c.text,
              line: c.lineMain || c.line || "",
              llm: { verdict: "cut", reason: "判为犹豫垫词" },
              guard: { rule: "standalone", value: false, limit: R.filler.standalonePauseSec },
              question: `「${c.text}」与前后文紧贴（前后停顿都不到 ${R.filler.standalonePauseSec}s），不像是独立插入语。删还是留？`,
              options: [{ label: "删除", cuts: [[c.s, c.e]] }, { label: "保留", cuts: [] }],
            });
          }
          console.log(`  候选 ${cands.length} 个 → LLM 判定删 ${picked.length} 个`);
          f2 = { cuts: picked.map((c) => [c.s, c.e]), report: picked.map((c) => ({ s: c.s, e: c.e, cut: c.text, kept: "（tier2 语气词，删除）", reason: `LLM 判为填充词${c.standalone ? "" : " · 与前后文紧贴"}` })) };
        } else console.log("  ⚠️ 语气词裁决不可用，跳过 tier2");
      }
    }
    // ── 语义冗余扫描(步3)：对**含片头尾的完整句段列表**一次性打标签 ──
    // 确定性检测（相似度/LCP/词时长）抓不到的三类，只能靠语义判断：
    //   ① 离题题外话（片头寒暄、片尾告别）  ② 口误（说错即改、但没把正确的话重说一遍）
    //   ③ 换说法重说（同义不同词，文本相似度天然失效）
    // 设计原则：LLM 只表态，剪不剪由下面四条**确定性护栏**裁决 ——
    //   ① 总删除时长 ≤ 全片 maxRatio（默认 22%），超了整批不剪（防"整片被删光"）
    //   ② 连续删除句段 ≤ maxRun（默认 3），防一段话被整块吞掉
    //   ③ paraphrase 必须给出**有效且向后的** keepId（永远保留后一遍），否则忽略
    //   ④ 单句跨度 > maxSegSec（默认 20s）基本是误判，忽略
    let rs = { cuts: [], report: [] };
    if (arbiterOk("redundancy-scan") && R.redundancy?.enabled !== false &&
        process.env.XUNJIAN_REDUNDANCY !== "off" && rawSegs.length >= 4) {
      const RS = R.redundancy || {};
      const nrmT = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
      step(`语义冗余扫描（${R.arbiter.model}，${rawSegs.length} 句）`);
      const v = adjudicate("redundancy", {
        segments: rawSegs.map((x, i) => ({
          id: i, s: +x.s.toFixed(2), e: +x.e.toFixed(2), text: nrmT(x.z),
        })),
      });
      if (v && Array.isArray(v.verdicts)) {
        // 裁决落盘：复核时"某句为什么没剪"全靠这张表，重放一次要花一次 API 调用。
        // 与 retake-report / filler-report 并列，只写原始标签，不做二次加工。
        try {
          fs.writeFileSync(path.join(EP, "work/redundancy-verdicts.json"), JSON.stringify({
            model: R.arbiter.model,
            segments: rawSegs.map((x, i) => ({ id: i, s: +x.s.toFixed(2), e: +x.e.toFixed(2), text: nrmT(x.z) })),
            verdicts: v.verdicts,
          }, null, 1));
        } catch (e) { console.log(`  ⚠️ 裁决明细写入失败: ${e.message}`); }
        const LABELS = new Set(["offtopic", "slip", "paraphrase", "filler"]);
        // ── 句段内子切口 ──
        // whisper 常把「说错/卡住」和「改正后重说」合并成一个长句段（实测 C0777
        // 「相反的一个脾气相反的一个脾气一点就着」22 字）。整句删会连正确内容一起丢，
        // 整句跳过又漏剪 —— 用户明确要求"只保留最终那一遍"。
        // 做法：找「句首短语在句中再次出现」的位置作锚点，只删第一次出现的前半段。
        const slipPrefixCut = (sg) => {
          const full = nrmT(sg.z);
          const ts = [];
          for (const w of sg.w || []) for (const _ of nrmT(w[2])) ts.push(w[0]);
          if (ts.length < full.length) return null;          // 词级时间戳缺失，放弃
          const maxL = Math.min(14, Math.floor(full.length / 2));
          for (let L = maxL; L >= 4; L--) {
            const head = full.slice(0, L);
            const k = full.indexOf(head, Math.max(3, L - 2));
            if (k > 0 && k <= full.length - 4) {
              const a = sg.s, b = ts[k];
              if (b - a < 0.3 || sg.e - b < 0.8) continue;  // 切出来太碎，不值当
              return { a, b, head, del: full.slice(0, k) };
            }
          }
          return null;
        };
        // 前件依赖词：以这些词开头的句子，语义上依附前一句（"第一个要改的是…"）。
        // 此时前一句是它的前件，不是"被它替代的旧说法"。
        const DEP_START = /^(第[一二三四五六七八九十]+个?|首先|其次|那么|所以|因为|如果|要是|否则|而|但是|但|不过|于是|於是)/;
        // 长 slip 的「重复片段」兜底：本句是卡壳/重说的前一遍，而**下一句原样说出了它中间的一段**
        // → 下一句才是最终版，本句整句可删。
        // 实测 c3 #8「我然后再说一点就是再说一点就是我觉得习惯也特别的重要啊，那你哪怕是一个人跑的」
        // （37 字 / 7.9s）与 #9「第三点，我觉得最后一点，我觉得习惯也特别的重要」（20 字）共有
        // 「我觉得习惯也特别的重要」11 字，但重复片段在**中段**而非句首，slipPrefixCut 找不到锚点 → 整段漏剪。
        // 三条反向护栏：① 公共片段 ≥10 字且其中汉字 ≥8（"是在2011年的"这类数字+虚词不算）；
        // ② 后一遍更短（前一遍是带重复的卡壳版）；③ 只认相邻下一句。宁漏勿错。
        const coveredByNext = (i) => {
          const a = nrmT(rawSegs[i].z), nx = rawSegs[i + 1];
          if (!a || !nx) return null;
          const b = nrmT(nx.z);
          if (!b || b.length >= a.length) return null;
          for (let L = Math.min(14, b.length); L >= 10; L--) {
            for (let k = 0; k + L <= a.length; k++) {
              const frag = a.slice(k, k + L);
              if ((frag.match(/[\u4e00-\u9fff]/g) || []).length < 8) continue;
              if (b.includes(frag)) return { frag, nextId: i + 1 };
            }
          }
          return null;
        };
        // 长 slip 的「段内重复短语」兜底（第三种形状）。
        // 实测 c1 #5（52 字 / 9.73s）：
        //   「我当年是在2011年的，我第二个是他在自己讲的专业要第二个是他对转讲，
        //     第二个是他对于自己讲内容要有一定的专长。」
        // 同一短语「第二个是他」在段内出现 3 次 —— 这是连卡三遍，最终版在后面的独立句段（#12）。
        // 但：重复在**中段**（slipPrefixCut 无锚点）、下一句不含公共片段（coveredByNext 不成立）
        // → 两条兜底都落空，LLM 已判 slip 却一字未剪。
        // 反向护栏：① 必须 5 字短语（4 字重复在正常口播里很常见：c3「一个好的状态/方法/习惯」）；
        // ② 只认 keepId 明确指向后面的句段（方向由 LLM 给定，不靠猜）。
        const repeatedPhrase = (i) => {
          const t = nrmT(rawSegs[i].z);
          if (t.length < 15) return null;
          const cnt = new Map();
          for (let k = 0; k + 5 <= t.length; k++) {
            const g = t.slice(k, k + 5);
            if ((g.match(/[\u4e00-\u9fff]/g) || []).length < 5) continue;
            const c = (cnt.get(g) || 0) + 1;
            cnt.set(g, c);
            if (c >= 3) return g;
          }
          return null;
        };
        // 长 slip 的「段内重来」兜底（第四种形状）：段首一小截作废后，同一 **≥7 字短语**从段内重来。
        // 实测 C0777 #2（40 字 / 8.8s）：
        //   「老是｜一个家庭里面最该成长的那天我觉得｜一个家庭里面最该成长的首先是爸爸，其次才是孩子。」
        // 第一遍从第 2 字起、第二遍从第 18 字起，公共短语 12 字 —— 但**两遍都不对齐段首**
        // （段首多了"老是"），所以 slipPrefixCut（要求从段首起始）与 detectInnerRetakes
        // （要求重来版从段首字开始）同时漏掉；重复只有 2 次，第三条 repeatedPhrase（≥3 次）也不命中。
        // #7 同理：「那看到孩｜当孩子看到爸爸的脸是这个｜当孩子看到爸爸脸是松的…」。
        // 四条护栏：① 公共短语 ≥7 字；② 第一遍起点在段首 ≤4 字内（确认是"起头"不是句中并列）；
        //          ③ 第二遍起点在段首 ≤22 字内（重来发生在开头，不是远距离呼应）；
        //          ④ 第二遍之后还剩 ≥12 字（保留的是完整句子）。
        const repeatedHead = (i) => {
          const t = nrmT(rawSegs[i].z);
          if (t.length < 30) return null;
          for (let L = 12; L >= 7; L--) {
            const last = new Map();
            for (let k = 0; k + L <= t.length; k++) {
              const g = t.slice(k, k + L);
              if ((g.match(/[\u4e00-\u9fff]/g) || []).length < L - 1) continue;
              const prev = last.get(g);
              if (prev == null) { last.set(g, k); continue; }
              if (prev <= 4 && k <= 22 && k - prev >= 2 && t.length - k >= 12) {
                return { frag: g, cutChars: k, firstAt: prev, text: t };
              }
              last.set(g, k);
            }
          }
          return null;
        };
        const picked = [];
        for (const it of v.verdicts) {
          const i = Number(it && it.id);
          if (!Number.isInteger(i) || i < 0 || i >= rawSegs.length) continue;
          const label = String((it && it.label) || "");
          if (!LABELS.has(label)) continue;
          // ── filler 不得整句删 ──
          // redundancy 的 filler 只表示"这句里夹了个语气词"，不是"整句该丢"。
          // 语气词已有专门通道做**词级切除**（tier1 直剪 / tier2 交 LLM 判上下文）。
          // 实测 c3：标了 filler 的「啊，那第二个我觉得是就一个人的状态」被整句删 3.9s，
          // 连带把「第二个」这个论点引导句一起删掉，成片只剩第一和第三个论点。
          if (label === "filler") {
            console.log(`  ↷ 忽略 filler（${nrmT(rawSegs[i].z).slice(0, 14)}）：语气词走词级切除，不整句删`);
            continue;
          }
          // ── offtopic 位置护栏（确定性）──
          // 实测 qwen-plus 会把「我当年毕业武汉大学拿遍了奖学金」「我 2011 年代表中国拿了
          // 世界冠军」这类**论据自述**判成 offtopic（理由"冗余权威背书、未转化为论证"），
          // 而它们恰恰在支撑前一句提出的「第一个是学习能力」「第二个是有专长」。
          // 粗剪不该做"论证是否有力"的编辑判断 —— 那会把视频剪成只剩论点、没有证据。
          // 故：offtopic 只允许出现在片头/片尾，中段一律保留（宁可漏剪）。
          if (label === "offtopic") {
            const hN = RS.offtopicHeadSegs ?? 2, tN = RS.offtopicTailSegs ?? 2;
            if (i >= hN && i < rawSegs.length - tN) {
              console.log(`  ↷ offtopic 位置护栏：保留 #${i}「${nrmT(rawSegs[i].z).slice(0, 14)}」（中段跑题极少，多为论据）`);
              pushReview({
                kind: "offtopic-mid", priority: 1, s: rawSegs[i].s, e: rawSegs[i].e, segId: i,
                text: nrmT(rawSegs[i].z).slice(0, 22), line: rawSegs[i].z,
                llm: { verdict: "cut", reason: it.reason || "判为离题内容" },
                guard: { rule: "offtopicPos", value: i, limit: `只允许片头${hN}句/片尾${tN}句` },
                question: `模型认为这句跑题，但它在中段（多半是论据）。删掉会少一段支撑，删还是留？`,
                options: [{ label: "删除", cuts: [[rawSegs[i].s, rawSegs[i].e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          // 重来版保护（确定性）：同一句说了两遍时，后一遍是最终要保留的版本。
          // 实测 C0779：LLM 把「当你管住了自己的表情」（重来版的第一句）判成"与前句重复起头"删掉，
          // 反而留下前一遍的半截，成片语义断裂。凡 DUP_HEAD 里的句子一律不删。
          if (DUP_HEAD.has(i)) {
            console.log(`  ↷ 重来版保护：保留 #${i}「${nrmT(rawSegs[i].z).slice(0, 12)}」，它是同一句重说的最终版本`);
            continue;
          }
          const sg = rawSegs[i];
          // ── 收尾呼应护栏（确定性）──
          // 口播视频常用"总—分—总"：结尾会把开场的总起句再说一遍。那是**结构**，不是口误。
          // 实测 c2：「如果是以上情况之一，都特别的适合」被 qwen 判成"与第 0 句重复"删掉，
          // 但第 6 句正是全片落点 —— 删了之后视频说完五个类型就戛然而止，没有收束。
          // 判据：落在全片后 30%、且与开场前两句有 ≥8 字公共片段 → 视为呼应，保留。
          if (i >= rawSegs.length * 0.7) {
            const cur = nrmT(sg.z);
            const heads = rawSegs.slice(0, 2).map((x) => nrmT(x.z)).filter(Boolean);
            const echoed = heads.some((h) => {
              for (let L = Math.min(12, cur.length, h.length); L >= 8; L--) {
                for (let k = 0; k + L <= cur.length; k++) {
                  if (h.includes(cur.slice(k, k + L))) return true;
                }
              }
              return false;
            });
            if (echoed) {
              console.log(`  ↷ 收尾呼应护栏：保留 #${i}「${cur.slice(0, 14)}」（与开场同构，是总结句不是口误）`);
              pushReview({
                kind: "echo-tail", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: cur.slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为与开场重复" },
                guard: { rule: "closingEcho", value: "与开场有≥8字公共片段", limit: "后30%视为收尾呼应" },
                question: `模型说这句和开场重复，但它出现在结尾（像是总结句）。删还是留？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          if (sg.e - sg.s > (RS.maxSegSec ?? 20)) continue;
          if (label === "slip" && nrmT(sg.z).length > (RS.slipMaxChars ?? 16)) {
            const pc = slipPrefixCut(sg);
            if (!pc) {
              // 兜底：下一句原样说出了本句中间的一段 → 本句是前一遍，整句删
              const tc = coveredByNext(i);
              if (tc) {
                console.log(`  ✂ 长 slip 整句删：「${tc.frag}」已由 #${tc.nextId} 完整重说（${(sg.e - sg.s).toFixed(1)}s）`);
                picked.push({ i, label, keepId: tc.nextId, reason: `${it.reason || ""} · 结尾被下一句完整重说` });
                continue;
              }
              // 第三兜底：段内同一 5 字短语重复 ≥3 次，且 keepId 指向后面的句段 → 整句是连卡版
              const kRaw = it.keepId == null ? null : Number(it.keepId);
              const kOk = Number.isInteger(kRaw) && kRaw > i && kRaw < rawSegs.length && !!nrmT(rawSegs[kRaw].z);
              const rp = kOk ? repeatedPhrase(i) : null;
              if (rp) {
                console.log(`  ✂ 长 slip 整句删：「${rp}」在句内重复 ≥3 次，最终版在 #${kRaw}（${(sg.e - sg.s).toFixed(1)}s）`);
                picked.push({ i, label, keepId: kRaw, reason: `${it.reason || ""} · 段内短语重复≥3次` });
                continue;
              }
              // 第四兜底：段首一小截作废后，同一 ≥7 字短语从段内重来 → 只删前半
              const rh = kOk ? repeatedHead(i) : null;
              if (rh) {
                const ts = [];
                for (const w of sg.w || []) for (const _ of nrmT(w[2])) ts.push(w[0]);
                if (ts.length >= rh.text.length) {
                  const cutAt = ts[rh.cutChars];
                  if (cutAt - sg.s >= 0.3 && cutAt - sg.s <= 12) {
                    console.log(`  ✂ 长 slip 段内重来：删前半「${rh.text.slice(0, rh.cutChars)}」${(cutAt - sg.s).toFixed(2)}s，保留从「${rh.frag}」起的重来版`);
                    picked.push({
                      i, label, keepId: kRaw,
                      reason: `${it.reason || ""} · 段内重来（公共短语「${rh.frag}」）`,
                      cutRange: [sg.s, cutAt], cutText: rh.text.slice(0, rh.cutChars),
                    });
                    continue;
                  }
                }
              }
              console.log(`  ↷ 跳过 slip（${nrmT(sg.z).length} 字 > ${RS.slipMaxChars ?? 16}，且找不到重复锚点）：${nrmT(sg.z).slice(0, 20)}…`);
              pushReview({
                kind: "slip-noref", priority: 1, s: sg.s, e: sg.e, segId: i,
                text: nrmT(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为重说/口误" },
                guard: { rule: "slipMaxChars", value: nrmT(sg.z).length, limit: RS.slipMaxChars ?? 16 },
                question: `模型说这句是重说，但 ${nrmT(sg.z).length} 字太长、找不到可对齐的重复切口。整句删还是留？`,
                options: [{ label: "整段删", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
            console.log(`  ✂ 句段内子切口：删前半「${pc.head}…」${(pc.b - pc.a).toFixed(2)}s，保留后半`);
            picked.push({ i, label, keepId: null, reason: `${it.reason || ""} · 句段内只删前一遍`, cutRange: [pc.a, pc.b], cutText: pc.del });
            continue;
          }
          // keepId 语义（v7）：slip / paraphrase 都应指向「最终保留的那一段」。
          // paraphrase 缺 keepId → 整条忽略（无法判断保留谁）；slip 缺 keepId → 允许（整句删）。
          let keepId = null;
          if (it.keepId != null) {
            const k = Number(it.keepId);
            const okK = Number.isInteger(k) && k > i && k < rawSegs.length &&
              rawSegs[k].s - sg.e <= (RS.paraphraseGapSec ?? 25) && !!nrmT(rawSegs[k].z);
            if (okK) keepId = k;
            else if (label === "paraphrase") {
              // 只允许"删前保后"，指错方向就别剪 —— 但这是模型给了具体意见却没落地，交用户判
              console.log(`  ↷ 跳过 paraphrase（keepId=${it.keepId} 指向不成立）：${nrmT(sg.z).slice(0, 14)}`);
              pushReview({
                kind: "paraphrase-dir", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: nrmT(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: `${it.reason || "判为换说法"} · keepId=${it.keepId}` },
                guard: { rule: "paraphraseKeepId", value: String(it.keepId), limit: "必须指向后方且≤25s" },
                question: `模型说这句是前一遍说法（该留的是后面那句），但它指的位置对不上。删了会不会丢掉唯一一遍？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          } else if (label === "paraphrase") {
            console.log(`  ↷ 跳过 paraphrase（缺 keepId）：${nrmT(sg.z).slice(0, 14)}`);
            pushReview({
              kind: "paraphrase-dir", priority: 2, s: sg.s, e: sg.e, segId: i,
              text: nrmT(sg.z).slice(0, 22), line: sg.z,
              llm: { verdict: "cut", reason: it.reason || "判为换说法（未给保留句）" },
              guard: { rule: "paraphraseKeepId", value: "null", limit: "必须指向后方且≤25s" },
              question: `模型说这句是前一遍说法，但没指出该保留哪一句。删了会不会丢掉唯一一遍？`,
              options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
            });
            continue;
          }
          // 护栏⑦：paraphrase 的"被删那一遍"必须**自身够长够完整**。
          // 实测 C0779：ASR 把「孩子学不好，第一个要改的是家里的环境」切成两句，
          // 前半只有 5 字 / 0.86s，却被当成"前一遍"删掉 —— 成片直接从「效率越来越好」
          // 跳到「第一个要改的是家里的环境」，条件句丢了。几个字的半句本来就不构成一遍完整说法。
          if (label === "paraphrase") {
            const dn = nrmT(sg.z).length, dd = sg.e - sg.s;
            if (dn < (RS.paraphraseMinChars ?? 8) || dd < (RS.paraphraseMinSec ?? 1.5)) {
              console.log(`  ↷ 跳过 paraphrase（被删句仅 ${dn} 字 / ${dd.toFixed(2)}s，不成句）：${nrmT(sg.z).slice(0, 16)}`);
              pushReview({
                kind: "paraphrase-short", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: nrmT(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为前一遍说法" },
                guard: { rule: "paraphraseMin", value: `${dn}字/${dd.toFixed(2)}s`, limit: `${RS.paraphraseMinChars ?? 8}字/${RS.paraphraseMinSec ?? 1.5}s` },
                question: `模型说这句是前一遍，但它只有 ${dn} 字、${dd.toFixed(2)}s，可能只是个半句。删还是留？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          // 护栏⑧：前件保护。keepId 那句以「第一个/首先/那么/而/因为…」开头时，
          // 它是后件的引导，被删句是它的前件而不是旧说法。
          if (keepId != null) {
            const kt = nrmT(rawSegs[keepId].z);
            if (DEP_START.test(kt)) {
              console.log(`  ↷ 前件保护：保留 #${i}「${nrmT(sg.z).slice(0, 12)}」，因为保留句 #${keepId} 以「${kt.slice(0, 3)}」开头，依赖本句作前件`);
              pushReview({
                kind: "dep-keep", priority: 2, s: sg.s, e: sg.e, segId: i,
                text: nrmT(sg.z).slice(0, 22), line: sg.z,
                llm: { verdict: "cut", reason: it.reason || "判为前一遍说法" },
                guard: { rule: "depStart", value: `#${keepId} 以「${kt.slice(0, 3)}」开头`, limit: "前件保护" },
                question: `模型说这句多余，但后面那句以「${kt.slice(0, 3)}」开头，靠它当前件。删了会不会断逻辑？`,
                options: [{ label: "删除", cuts: [[sg.s, sg.e]] }, { label: "保留", cuts: [] }],
              });
              continue;
            }
          }
          picked.push({ i, label, keepId, reason: it.reason || "" });
        }
        picked.sort((a, b) => a.i - b.i);
        const segDur = (p) => p.cutRange ? (p.cutRange[1] - p.cutRange[0]) : (rawSegs[p.i].e - rawSegs[p.i].s);
        // 护栏⑤：连续 slip / paraphrase 视为"同一处重复的多次尝试"，**只保留最后一遍**。
        // 旧规则（连续 slip 只删前一句）会留下中间那一遍：C0779 三遍带货话术删到只剩 2 遍就是这个原因。
        // 口误/重说的语义永远是"删前保后"，所以链尾一律保留、链上前面的全删。
        const RUN_CUT = new Set(["slip", "paraphrase"]);
        const chainOk = [];
        for (let k = 0; k < picked.length; k++) {
          const p = picked[k];
          if (!RUN_CUT.has(p.label)) { chainOk.push(p); continue; }
          let j = k;
          while (j + 1 < picked.length && picked[j + 1].i === picked[j].i + 1 && RUN_CUT.has(picked[j + 1].label)) j++;
          if (j > k) {
            // 链尾未必是"最完整的那一遍"：链内若有人标了 paraphrase 的 keepId，就以它为终点
            // （实测 C0793：链 #7–#12 的链尾是口误残句「各个科目的提高身的」，
            //   真正该保留的是 #11 指向的 #13「现在临近期中」）。
            let keepIdx = picked[j].i;
            for (let t = k; t <= j; t++) {
              const kp = picked[t].keepId;
              if (Number.isInteger(kp) && kp > keepIdx && nrmT(rawSegs[kp]?.z)) keepIdx = kp;
            }
            for (let t = k; t <= j; t++) if (picked[t].i < keepIdx) chainOk.push({ ...picked[t], chain: true });
            console.log(`  ↷ 连续重说链 #${picked[k].i}–#${picked[j].i}：删前 ${j - k + 1} 句，只保留最后一遍 #${keepIdx}「${nrmT(rawSegs[keepIdx].z).slice(0, 16)}」`);
            k = j;
          } else chainOk.push(p);
        }
        // 护栏⑥：被 slip/paraphrase 指定为"要保留的最终那一段"的句子，一律不许删
        const protectedIdx = new Set(
          chainOk.filter((p) => p.keepId != null).map((p) => p.keepId));
        const safePicked = chainOk.filter((p) => !protectedIdx.has(p.i));
        // 护栏⑦：逻辑续接。删除句的**下一句**若以「而是/但是/所以/因为/不过/而且…」开头，
        // 删掉前句会让后句失去依托。实测 C0779：删掉「所以很多时候不是孩子不争气」后，
        // 成片直接从「他的效率越来越低」跳到「而是家里的环境把他学习那种」，因果链断在半空。
        const BREAK_START = /^(而是|但是|但|所以|因为|不過|不过|而且|于是|於是|可是|然而|同时|同時|另外)/;
        const _del0 = new Set(safePicked.map((p) => p.i));
        const linkOk = safePicked.filter((p) => {
          let j = p.i + 1;
          while (j < rawSegs.length && _del0.has(j)) j++;
          if (j >= rawSegs.length) return true;
          const t = nrmT(rawSegs[j].z);
          if (BREAK_START.test(t)) {
            console.log(`  ↷ 逻辑续接护栏：保留 #${p.i}「${nrmT(rawSegs[p.i].z).slice(0, 12)}」，否则下一句「${t.slice(0, 10)}…」失去上文`);
            pushReview({
              kind: "logic-link", priority: 2, s: rawSegs[p.i].s, e: rawSegs[p.i].e, segId: p.i,
              text: nrmT(rawSegs[p.i].z).slice(0, 22), line: rawSegs[p.i].z,
              llm: { verdict: "cut", reason: p.reason || "判为多余" },
              guard: { rule: "breakStart", value: t.slice(0, 6), limit: "下一句以转折/因果连词开头" },
              question: `删掉这句后，下一句会以「${t.slice(0, 4)}」开头、失去上文。删还是留？`,
              options: [{ label: "删除", cuts: [[rawSegs[p.i].s, rawSegs[p.i].e]] }, { label: "保留", cuts: [] }],
            });
            return false;
          }
          return true;
        });
        // 护栏②：连续删除上限（重说链除外）
        // 链内每一句都指向同一个 keepId＝同一处重复，整链该删干净；若也计入连续上限，
        // 会在链中间留下一两句"漏网的重复遍"（实测 C0793 链长 10 句时保留了一句残句）。
        const MAXRUN = RS.maxRun ?? 6;
        const keepRun = [];
        let run = 0;
        for (const p of linkOk) {
          if (p.chain) { keepRun.push(p); continue; }
          run = keepRun.length && p.i === keepRun[keepRun.length - 1].i + 1 ? run + 1 : 1;
          if (run <= MAXRUN) keepRun.push(p);
          else console.log(`  ⚠️ 连续 ${run} 句被判删，超过上限 ${MAXRUN}，保留第 ${p.i} 句`);
        }
        // 护栏①：总时长上限
        const cutDur = keepRun.reduce((a, p) => a + segDur(p), 0);
        const cap = rawDur * (RS.maxRatio ?? 0.35);
        let final = keepRun;
        if (cutDur > cap) {
          console.log(`  ⚠️ 判定删除 ${cutDur.toFixed(1)}s 超过上限 ${cap.toFixed(1)}s，整批不剪（防误删）`);
          pushReview({
            kind: "batch-over", priority: 1, s: 0, e: rawDur, segId: -1,
            text: `模型判定删除 ${cutDur.toFixed(1)}s（${(cutDur / rawDur * 100).toFixed(0)}%）`,
            line: keepRun.map((p) => nrmT(rawSegs[p.i].z).slice(0, 10)).join(" / ").slice(0, 120),
            llm: { verdict: "cut", reason: `共 ${keepRun.length} 句` },
            guard: { rule: "maxRatio", value: `${(cutDur / rawDur * 100).toFixed(0)}%`, limit: `≤${((RS.maxRatio ?? 0.35) * 100).toFixed(0)}%` },
            question: `这一批判定要删 ${cutDur.toFixed(1)}s，超过全片 ${((RS.maxRatio ?? 0.35) * 100).toFixed(0)}% 的保护线，已全部保留。是否按模型意见删掉？`,
            options: [
              { label: "保持不剪", cuts: [] },
              { label: "按模型全删", cuts: keepRun.map((p) => (p.cutRange ? p.cutRange : [rawSegs[p.i].s, rawSegs[p.i].e])) },
            ],
          });
          final = [];
        }
        // 残片回收：≤2 字、且前后句都被删的孤立碎片，一并删（它们是被删句的尾巴）
        const cutIdx = new Set(final.map((p) => p.i));
        for (let grew = true; grew;) {
          grew = false;
          for (let j = 1; j < rawSegs.length - 1; j++) {
            if (cutIdx.has(j) || nrmT(rawSegs[j].z).length > 2) continue;
            if (cutIdx.has(j - 1) && cutIdx.has(j + 1)) {
              cutIdx.add(j);
              final.push({ i: j, label: "fragment", keepId: null, reason: "被删句之间的孤立残片" });
              grew = true;
            }
          }
        }
        final.sort((a, b) => a.i - b.i);
        const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
        console.log(`  判定删除 ${final.length}/${rawSegs.length} 句（${cutDur.toFixed(1)}s）`);
        for (const p of final)
          console.log(`    ⌫ [${fmtT(p.cutRange ? p.cutRange[0] : rawSegs[p.i].s)}${p.cutRange ? `~${(p.cutRange[1] - p.cutRange[0]).toFixed(2)}s` : ""}] ${p.label}${p.keepId != null ? `→保留#${p.keepId}` : ""}「${p.cutText || nrmT(rawSegs[p.i].z)}」${p.reason ? " · " + p.reason : ""}`);
        rs = {
          // 整句删 → 走静音吸附；句段内子切口 → 切口落在词间，吸附会把后半正确内容吞掉，故原样保留
          cuts: final.filter((p) => !p.cutRange).map((p) => [rawSegs[p.i].s, rawSegs[p.i].e]),
          subCuts: final.filter((p) => p.cutRange).map((p) => p.cutRange),
          report: final.map((p) => ({
            s: p.cutRange ? p.cutRange[0] : rawSegs[p.i].s,
            e: p.cutRange ? p.cutRange[1] : rawSegs[p.i].e,
            cut: p.cutText ? p.cutText : nrmT(rawSegs[p.i].z),
            kept: p.keepId != null ? nrmT(rawSegs[p.keepId].z) : (p.cutRange ? "（同句后半，保留）" : "（语义冗余，删除）"),
            reason: `语义扫描：${p.label}${p.reason ? " · " + p.reason : ""}`,
          })),
        };
      } else console.log("  ⚠️ 语义扫描裁决不可用，跳过");
    }
    const report = [...rt.report, ...st.report, ...fl.report, ...f2.report, ...rs.report];

    // 切口吸附到真实静音:whisper 的词边界会把停顿算进词长(实测偏差 0.7s 以上),
    // 直接按它切会在保留段里留下"几十~几百毫秒的残音碎片 + 一段孤立静音",
    // 成片转写会把碎片听成辅音并幻觉出一个不存在的词(实测切口处产出幻觉字幕「保护」)。
    // 做法:起点退回所在静音的开头;终点吞掉紧随其后的静音,并在下一段语音起点前留 tailProtectSec 保护。
    const SNAP = R.segment.snap;
    const fine = run(FFMPEG, ["-i", input, "-vn", "-af", `silencedetect=noise=${NOISE}dB:d=${SNAP.fineSilenceSec}`, "-f", "null", "-"]);
    const flog = fine.stderr || "";
    const fs0 = [...flog.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
    const fe0 = [...flog.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
    const pauses = fs0.map((s, i) => [s, fe0[i] ?? rawDur]).filter(([s, e]) => e - s > R.segment.pauseMinSec);
    // 语音句段边界：吸附静音时用它兜底，防止把夹在中间的**语音**一并吞掉。
    // 实测坑（v3-C0779）：重说切口 [16.35,17.89] 的终点向前找静音时，跨过了 17.84-19.28 的正常语音，
    // 把「第一個該改的不是孩子」整句删掉（成片首句从「…我觉得孩子成绩不好第一个该改的不是孩子而是家里的环境」
    // 变成「…而是家里的环境」）。同理，若一段"静音"里其实夹着语音句段，则它不是纯静音，不可用于起点回退。
    const segBounds = (rawSegs || []).map((x) => [x.s, x.e]).sort((x, y) => x[0] - y[0]);
    // 语音起点表：句段界 + **字级起点**。
    // whisper 时代一句 5~6 秒、段界足够密，只看句段界就够；paraformer 的句段粗得多
    // （实测 c3 第 0 段跨 6.3s），语句内部没有任何"边界"可拦，于是语气词切口向后找静音时
    // 会跨过真实语音：实测 c3 切口 [2.25,2.54] 被吸成 [2.25,3.47]，把「客 观 承 认」整段吞掉。
    // 这里补一层字级起点判断 —— 只要静音段内出现任何一个字的起点，就不是纯静音。
    const wordStarts = (rawSegs || []).flatMap((x) => (x.w || []).map((w) => w[0])).sort((a, b) => a - b);
    const hasSpeechIn = (ss, se) => {
      const lo = ss + SNAP.speechGuardSec, hi = se - SNAP.speechGuardSec;
      if (hi <= lo) return false;
      if (segBounds.some(([bs]) => bs > lo && bs < hi)) return true;
      let a = 0, b = wordStarts.length;
      while (a < b) { const m = (a + b) >> 1; if (wordStarts[m] <= lo) a = m + 1; else b = m; }
      return a < wordStarts.length && wordStarts[a] < hi;
    };
    const snapCut = ([cs, ce]) => {
      let a = cs, b = ce;
      const inside = pauses.find(([ss, se]) => cs > ss && cs < se && !hasSpeechIn(ss, se));
      if (inside) a = inside[0];
      const next = pauses.find(([ss, se]) =>
        ss >= a - SNAP.insideToleranceSec && se > ce + SNAP.fineTailPadSec &&
        ss - ce <= SNAP.searchNextWithinSec &&
        !hasSpeechIn(ce, se));   // 中间夹着语音 → 不许吞
      if (next) b = Math.max(b, next[1] - SNAP.tailProtectSec);
      return [a, b];
    };
    // 吸附静音可能把两个原本相邻的候选取向同一个静音尾，产生重叠切口（拿去做减法虽不出错，
    // 但报告里会出现 [63.8-64.4] [64.0-64.4] 这种重叠区间，人工核对时很费解）→ 合并一次。
    const cutsRaw = [...rt.cuts, ...st.cuts, ...fl.cuts, ...f2.cuts, ...rs.cuts].map(snapCut)
      // 补充要求给的是**用户点名的原文区间**，不能再做静音吸附：吸附会把切口往回/往后吞，
      // 实测会把"删掉最后一句"变成"连下一句开头一起吞"。原样并入，只参与合并排序。
      .concat(rs.subCuts || [])
      .concat(NOTE_DIR.cuts)
      .sort((x, y) => x[0] - y[0]);
    const cuts = [];
    for (const c of cutsRaw) {
      const l = cuts[cuts.length - 1];
      if (l && c[0] <= l[1] + (R.retake.mergeGapSec ?? 0.1)) l[1] = Math.max(l[1], c[1]);
      else cuts.push([...c]);
    }
    // 要求里"保留"的片段优先：其它剪点一律不许越过它们
    if (NOTE_DIR.keeps.length && cuts.length) {
      const out = [];
      for (const [a, b] of cuts) {
        let parts = [[a, b]];
        for (const [ks, ke] of NOTE_DIR.keeps) {
          const nx = [];
          for (const [x, y] of parts) {
            if (ke <= x || ks >= y) { nx.push([x, y]); continue; }
            if (ks > x) nx.push([x, Math.min(ks, y)]);
            if (ke < y) nx.push([Math.max(ke, x), y]);
          }
          parts = nx;
        }
        out.push(...parts.filter(([x, y]) => y - x > 0.2));
      }
      cuts.length = 0;
      cuts.push(...out);
    }
    cutsGlobal = cuts;
    if (fl.report.length || f2.report.length || fl.cuts.length || f2.cuts.length)
      fs.writeFileSync(path.join(EP, "work/filler-report.json"),
        JSON.stringify({ tier1: { report: fl.report, cuts: fl.cuts }, tier2: { report: f2.report, cuts: f2.cuts } }, null, 1));
    if (cuts.length) {
      segs = subtractRanges(segs, cuts, R.retake.minRemainSec);
      segs = segs.filter(([s, e]) => e - s > R.segment.minKeptSec);   // 丢弃剪后残留的碎片段(它们正是幻觉字幕的来源)
      if (!segs.length) segs = [[0, rawDur]];
      const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(1).padStart(4, "0")}`;
      console.log(`  剪掉 ${report.length} 处冗余(重说/卡壳,保留后一遍,切口已吸附静音)` +
        `${NOTE_DIR.cuts.length ? ` + 补充要求命中 ${NOTE_DIR.cuts.length} 段` : ""}——请核对,误剪就加 --no-retake 重跑:`);
      for (const r of report) console.log(`    ✂「${r.cut}」→ 保留「${r.kept}」${r.reason ? " · " + r.reason : ""}`);
      console.log(`    实际切口: ${cuts.map(([s, e]) => `[${fmt(s)}-${fmt(e)}]`).join(" ")}`);
      fs.writeFileSync(path.join(EP, "work/retake-report.json"), JSON.stringify({ report, cuts }, null, 1));
    } else console.log("  未发现重说段 ✓");
  } else console.log("  ⚠️ 转写不可用(需安装 uv),跳过重说检测");
}
// 剪完之后「新的首尾」可能又露出短碎片（原本被前一句挡着）→ 再过滤一次
{
  const r1 = dropEdgeFrags(segs);
  if (r1.dropped.length) {
    segs = r1.list;
    console.log(`  剪后首尾再清 ${r1.dropped.length} 处短碎片：` +
      r1.dropped.map(([s, e]) => `[${s.toFixed(2)}-${e.toFixed(2)}]`).join(" "));
  }
}
// ── 段尾回声：前一段的尾巴其实是下一句的起头（跨段假起头）──
// 实测 C0777：seg7 结尾「…题目也钻得进去**相反的一个脾气**。」（60.72–62.16），
// seg8 从「**相反的一个脾气**一点就着…」（64.38 起）重说。两段之间 2.22s 静音被丢弃，
// 成片里两遍直接焊成「相反的一个脾气 / 相反的一个脾气」。
// 现有判据（DUP_HEAD、假起头延伸、inner-retake）都在「段首↔段首」或「段内」，
// 管不到「前段段尾 ↔ 后段段首」；LLM 那边 #7 已判 slip，但它只给「整句 + keepId」，
// 执行层 slipPrefixCut 只会切头、切不了尾 —— 这一刀必须在这里补。
// 判据（全部满足才删）：① 前段末 k 字 == 后段首 k 字，k≥4；② 两段间隔 ≤3s（同一口气的自我打断）；
// ③ 缩尾后前段仍 ≥0.8s（否则整段删）；④ 被删时长 0.2~2.5s。
{
  const _nzT = (t) => String(t || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  const charsOf = ([s, e]) => {
    const out = [];
    for (const sg of RAW_SEGS) {
      if (sg.e <= s - 0.02 || sg.s >= e + 0.02) continue;
      for (const [ws, we, word] of sg.w || []) {
        const clean = _nzT(word);
        if (!clean || ws < s - 0.02 || we > e + 0.02) continue;
        const n = clean.length, per = (we - ws) / n;
        let k = 0;
        for (const ch of clean) { out.push([ch, ws + per * k, ws + per * (k + 1)]); k++; }
      }
    }
    return out.sort((a, b) => a[1] - b[1]);
  };
  const TAILK = 4, TAILGAP = 3.0, TAILCUTMAX = 2.5, TAILMINLEFT = 0.8;
  const hits = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const a = charsOf(segs[i]), b = charsOf(segs[i + 1]);
    if (a.length < TAILK || b.length < TAILK) continue;
    if (segs[i + 1][0] - segs[i][1] > TAILGAP) continue;
    let k = 0, ok = false;
    for (k = Math.min(8, a.length, b.length); k >= TAILK; k--) {
      if (a.slice(a.length - k).map((c) => c[0]).join("") === b.slice(0, k).map((c) => c[0]).join("")) { ok = true; break; }
    }
    if (!ok) continue;
    const cutAt = a[a.length - k][1];
    const dur = segs[i][1] - cutAt;
    if (dur < 0.2 || dur > TAILCUTMAX) continue;
    hits.push({ i, k, cutAt, dur, tail: a.slice(a.length - k).map((c) => c[0]).join("") });
  }
  if (hits.length) {
    const gone = new Set(), addCuts = [];
    for (const h of hits) {
      const [s0, e0] = segs[h.i];
      if (h.cutAt - s0 < TAILMINLEFT) {
        gone.add(h.i); addCuts.push([s0, e0]);
        console.log(`  ✂ 段尾回声：整段删 [${s0.toFixed(2)}-${e0.toFixed(2)}]「…${h.tail}」（下一段从「${h.tail}」重说，本段只剩 ${(h.cutAt - s0).toFixed(2)}s 无内容）`);
      } else {
        segs[h.i] = [s0, h.cutAt]; addCuts.push([h.cutAt, e0]);
        console.log(`  ✂ 段尾回声：删前段尾部「${h.tail}」${h.dur.toFixed(2)}s（与下一段开头重合 ${h.k} 字）`);
      }
    }
    if (gone.size) segs = segs.filter((_, i) => !gone.has(i));
    cutsGlobal = [...cutsGlobal, ...addCuts].sort((x, y) => x[0] - y[0]);
  }
}
// ── 剪后中间孤立残句过滤 ──
// 前一句被判冗余删掉后，有时会剩下一个 3~4 字的孤立短段，前后都是长静音，
// 留在成片里上下文接不上（典型是上一句的尾巴）。
// 判据（全部满足才删）：非首尾段 / 段长 <0.8s / 文本 ≤6 字 / 与前段间隔 ≥1.0s / 与后段间隔 ≥1.5s。
// **设问短句例外**：「为什么/为啥/怎么回事/然后呢」本身就是独立短句，前后有停顿是正常的，
// 删了就变成"结论突然跳出来"，自问自答的逻辑断了（实测 C0777 1:33.5 的「为什么？」被这条规则删掉，
// 用户明确判定为"无关联漏剪"）。
{
  const ISO_MAX = 0.8, ISO_CHARS = 6, GAP_B = 1.0, GAP_A = 1.5;
  const KEEP_Q = /^(为什么|为啥|咋回事|怎么回事|怎么说|什么意思|然后呢|所以呢|对吧|是吧)/;
  const nrm = (t) => String(t || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  const txtAt = ([s, e]) => {
    const inside = RAW_SEGS.find((t) => t.s >= s - 0.3 && t.e <= e + 0.3);
    const overlap = RAW_SEGS.filter((t) => t.s < e && t.e > s)
      .sort((a, b) => (b.e - b.s) - (a.e - a.s))[0];
    return nrm((inside || overlap || {}).z);
  };
  const iso = [];
  for (let i = 1; i < segs.length - 1; i++) {
    const [s, e] = segs[i];
    if (e - s >= ISO_MAX) continue;
    if (s - segs[i - 1][1] < GAP_B || segs[i + 1][0] - e < GAP_A) continue;
    const txt = txtAt(segs[i]);
    if (!txt || txt.length > ISO_CHARS) continue;
    if (KEEP_Q.test(txt)) {
      // 设问例外要加一条**后件**条件：真正的自问自答，解释句是紧跟的（间隔通常 <1.5s，
      // 这种根本进不了本块 —— 上面的 GAP_A 已经放行了）。能走到这里的设问，后件至少隔 1.5s。
      // 实测 C0777：93.52 的「为什么？」后面隔 5.01s 才是「孩子的专注…」，而它的前句
      // （#11「孩子的专注，孩子的底气」）已被判 paraphrase 删掉 —— 前件没了、后件隔 5 秒，
      // 这不是自问自答，是录制被打断留下的孤句。故后件 >2.5s 不放行。
      const QFOLLOW = R.redundancy.keptQuestionFollowSec ?? 2.5;
      const nextGap = segs[i + 1][0] - e;
      if (nextGap <= QFOLLOW) {
        console.log(`  ↷ 保留孤立设问「${txt}」（下文 ${nextGap.toFixed(2)}s 内跟上，自问自答成立）`);
        continue;
      }
      console.log(`  ↷ 设问孤立「${txt}」：下文隔 ${nextGap.toFixed(2)}s，无自答，按半截话处理`);
    }
    iso.push({ seg: segs[i], txt });
  }
  if (iso.length) {
    const drop = new Set(iso.map((x) => x.seg));
    segs = segs.filter((sg) => !drop.has(sg));
    cutsGlobal = [...cutsGlobal, ...iso.map((x) => x.seg)].sort((a, b) => a[0] - b[0]);
    console.log(`  清理中间孤立残句 ${iso.length} 处（前后均长静音、字数极少，判为半截话）：`);
    for (const x of iso) console.log(`    ✂ [${x.seg[0].toFixed(2)}-${x.seg[1].toFixed(2)}]「${x.txt}」`);
  }
}
// ── 3. 剪切 + 提速 + 转码（编辑器友好的密集关键帧）──
step(Math.abs(SPEED - 1) < 1e-9 ? "剪切并转码（1.0x，不提速）" : `剪切并提速 ${SPEED}x`);
fs.mkdirSync(path.join(EP, "work"), { recursive: true });
fs.mkdirSync(path.join(EP, "hf/assets"), { recursive: true });
// 边界淡化:atrim 是硬切,拼接处波形直接从有声跳到有声/无声,产生突跳(click)。
// 成片转写会把这种突跳"听"成辅音,进而幻觉出一个不存在的词(实测边界处产出幻觉字幕「保护」)。
// 对每段的音频两端加极短淡入淡出即可消除突跳;淡化落在被剪掉的静音一侧,不削弱正常字音。
// 默认值见 rules.json segment.edgeFadeSec,可用 XUNJIAN_EDGE_FADE 覆盖(设 0 关闭)。
const FADE = Math.max(0, Number(process.env.XUNJIAN_EDGE_FADE ?? R.segment.edgeFadeSec));
// 单链 select 版滤镜图：N 段不再展开成 N 条 trim 分支（那些分支会把 commit 内存吃到 GB 级，
// 见 cutfilters.mjs 顶部的事故记录）。边界淡化由 buildCutFilter 用 V 形 volume 还原。
const fc = buildCutFilter(segs, { speed: SPEED, fade: FADE });
if (FADE > 0) console.log(`  剪切边界淡化 ${(FADE * 1000).toFixed(0)}ms(消除拼接突跳与幻觉字幕)`);
// 审核队列落盘：剪辑台读这个文件生成「时间轴标记 + 提问卡」，用户改的决定写进 overrides.json，
// 再由 firstcut/reexport.mjs 按区间重剪 —— 全程不回模型，结论不会漂。
// 先与**最终保留段**求交：落在气口已剪区间里的条目点了「删除」也没有效果，必须剔除。
const _rq = clipReviewItems(REVIEW, segs);
fs.writeFileSync(path.join(EP, "work/review-queue.json"), JSON.stringify(
  { name: NAME, rawDur: +rawDur.toFixed(3), items: _rq.items }, null, 1));
if (_rq.items.length || _rq.dropped)
  console.log(`  ? 待你确认 ${_rq.items.length} 条${_rq.dropped ? `（另有 ${_rq.dropped} 条落在已剪区间，已剔除）` : ""} → work/review-queue.json`);
// 落盘剪切计划:保留段/切口/提速/淡化,供离线复算"输出时间 ↔ 原片时间"映射,
// 用来定位成片转写里的幻觉字幕落在哪个拼接边界上(边界幻觉回归验证脚本读这个文件)。
// input/name 供 reexport.mjs 从计划直接重剪，不必重跑转写。
fs.writeFileSync(path.join(EP, "work/cut-plan.json"), JSON.stringify(
  { name: NAME, input: path.resolve(input), rawDur: +rawDur.toFixed(3), speed: SPEED, fade: FADE, noise: NOISE, segs, cuts: cutsGlobal }, null, 1));
const fcPath = path.join(EP, "work/cutfc.txt");
fs.writeFileSync(fcPath, fc);
const camName = "cam-" + NAME + ".mp4";
const cam = path.join(EP, "hf/assets", camName);
// 先写 .part.mp4，成片探测通过才原子改名 —— 与 reexport.mjs 同一套。
// 为什么首剪也要：ffmpeg 中途失败时留下的半截文件用的是正式名字，
// 下一次重跑 -y 会把它截断重写，结果「版本档里记着 140s、磁盘上只有 22s」。
const camPart = cam.replace(/\.mp4$/i, ".part.mp4");
try { fs.unlinkSync(camPart); } catch {}
const cutArgs = (fcArgs) => ["-y", "-v", "error", "-i", input, ...fcArgs,
  "-map", "[vf]", "-map", "[af]", "-c:v", "libx264", "-crf", `${R.encode.crf}`, "-preset", `${R.encode.preset}`,
  "-pix_fmt", "yuv420p", "-g", `${R.encode.gopFrames}`, "-c:a", "aac", "-b:a", `${R.encode.audioBitrate}`, camPart];
let r = run(FFMPEG, cutArgs(["-filter_complex_script", fcPath]));
if (r.status !== 0 && /Unrecognized option 'filter_complex_script'/.test(r.stderr || "")) {
  // ffmpeg 7.0 起废弃该选项,部分新构建(如 Windows choco 版)已移除 → 滤镜图改内联直传
  r = run(FFMPEG, cutArgs(["-filter_complex", fc.replace(/\n/g, "")]));
}
if (r.status !== 0) {
  try { fs.unlinkSync(camPart); } catch {}
  die("剪切失败: " + r.stderr?.slice(-300));
}

step("响度归一 (loudnorm 单独一步)");
const voice = path.join(EP, "work/voice-norm.wav");
r = run(FFMPEG, ["-y", "-v", "error", "-i", camPart, "-vn", "-af", `loudnorm=${R.encode.loudnorm}`, "-ar", "48000", voice]);
if (r.status !== 0) die("loudnorm 失败");
const dur = Number(run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", camPart]).stdout.trim());
if (!Number.isFinite(dur) || dur <= 0) { try { fs.unlinkSync(camPart); } catch {} die("成片时长探测失败，疑似合片被中断"); }
try { fs.unlinkSync(cam); } catch {}
fs.renameSync(camPart, cam);   // 从这一刻起才对本机版本扫描可见
console.log(`  成片素材 ${dur.toFixed(1)}s → ${path.relative(ROOT, cam)}`);

// ── 版本链登记 ──
// 首剪记 v1；「AI 剪辑」重跑由服务端先冻结旧版（cam-x.mp4 → cam-x.vN.mp4），
// 再传 XUNJIAN_REBASE_TO=<新版本号>，这里按那个号登记，绝不覆盖 v1。
try {
  const vp = path.join(EP, "work/versions.json");
  let vs = { name: NAME, current: 1, items: [] };
  if (fs.existsSync(vp)) {
    try {
      const j = JSON.parse(fs.readFileSync(vp, "utf8"));
      if (Array.isArray(j.items)) vs = { name: NAME, current: j.current || 1, items: j.items };
    } catch {}
  }
  const wantV = REBASE_TO > 0 ? REBASE_TO : 1;
  const isRebase = REBASE_TO > 0;
  const rec = { v: wantV, file: `hf/assets/${camName}`, kind: isRebase ? "rebase" : "cut",
    at: new Date().toISOString(),
    dur: +dur.toFixed(3), segs: segs.length, decisions: 0, cuts: cutsGlobal.length,
    note: isRebase
      ? `AI 重跑 v${wantV}（${segs.length} 段${EXTRA_NOTE
          ? ` · 带补充要求${NOTE_DIR.cuts.length ? ` 命中 ${NOTE_DIR.cuts.length} 处` : "（未命中片段）"}`
          : ""}）`
      : `首剪（${segs.length} 段 · 规则裁决）` };
  if (isRebase) {
    vs.items = (vs.items || []).filter((x) => Number(x.v) !== wantV);   // 同号先清掉，避免重复条目
    vs.items.push(rec);
  } else {
    const at = vs.items.findIndex((x) => Number(x.v) === 1);
    if (at >= 0) vs.items[at] = { ...vs.items[at], ...rec };   // 重跑首剪会覆盖 v1，记录跟着更新
    else vs.items.push(rec);
  }
  vs.items.sort((a, b) => a.v - b.v);
  vs.current = wantV;                             // 刚剪完，最新版就是这一版
  fs.writeFileSync(vp, JSON.stringify(vs, null, 1));
} catch (e) {
  console.warn(`  ⚠️ 版本档写入失败（不影响成片）：${e.message}`);
}

// ── --cut-only：剪辑层到此为止 ──
if (CUT_ONLY) {
  const kept = segs.reduce((a, [s, e]) => a + e - s, 0);
  console.log(`\n✅ 剪辑层完成（--cut-only）`);
  console.log(`   原片 ${rawDur.toFixed(1)}s → 成片 ${dur.toFixed(1)}s（保留 ${segs.length} 段，${(dur / rawDur * 100).toFixed(0)}%），提速 ${SPEED}x`);
  console.log(`   成片: ${path.relative(ROOT, cam)}`);
  console.log(`   剪点清单: ${path.relative(ROOT, path.join(EP, "work/retake-report.json"))} · 剪切计划: work/cut-plan.json`);
  process.exit(0);
}

// ── 4. 转写字幕（uv + faster-whisper，缺环境则跳过）──
step("转写逐字字幕");
const capsPath = path.join(EP, "work/caps-full.json");
const asrIn = path.join(EP, "work/asr-in.wav");
run(FFMPEG, ["-y", "-v", "error", "-i", voice, "-ac", "1", "-ar", "16000", asrIn]);
// v4：成片字幕改为**关热词**转写 + 分块 + 覆盖缺口检测（asr_and_caps.py 内建）。
// 原用热词(initial_prompt)提术语准确率，但实测会触发 whisper 整段跳读、丢大段语音；
// 术语错字改由 caption.fixes 词典 + LLM 同音纠错兜底。
// cloud：一次云端转写拿 IR，再用 asr_and_caps.py 的 replay 入口在本地断行（不二次计费）。
const capsSegsPath = path.join(EP, "work/caps-segs.json");
const asr = transcribeCaps(asrIn, capsPath, capsSegsPath);
let caps = [];
if (asr.status === 0 && fs.existsSync(capsPath)) {
  caps = JSON.parse(fs.readFileSync(capsPath, "utf8"));
  console.log("  " + (asr.stdout.trim().split("\n").pop() || `${caps.length} 行字幕`));
} else {
  fs.writeFileSync(capsPath, "[]");
  console.log(`  ⚠️ 成片转写失败: ${asrFail(asr)}`);
  console.log("     （需 uv: https://docs.astral.sh/uv/ ；模型下载受阻时设 HF_ENDPOINT=https://hf-mirror.com）");
}

// ── 4.4 错字纠错(①):LLM 同音纠错,只纠别字、严禁改写(默认关闭,先 A/B 验证)──
if (!NO_AI && (R.corrections.enabled || process.env.XUNJIAN_CORRECTIONS === "1") && arbiterOk("asr-fix") && caps.length) {
  step(`错字纠错（${R.arbiter.model}）`);
  const glossary = [];
  try {
    const hw = fs.readFileSync(path.join(ROOT, "firstcut/hotwords.txt"), "utf8")
      .split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
    glossary.push(...hw);
  } catch { /* 无热词文件则忽略 */ }
  glossary.push(...((R.caption && R.caption.userDict) || []));
  // 分批送 LLM:整片一次送会让小模型趋于保守(实测几乎不改),每批 ~6 行产出明显更好
  const CH = R.corrections.chunkSize ?? 6;
  const allLines = caps.map((c, i) => ({ id: i, text: c.z }));
  const fixList = [];
  for (let k = 0; k < allLines.length; k += CH) {
    const vv = adjudicate("asrfix", { glossary: [...new Set(glossary)], lines: allLines.slice(k, k + CH) });
    if (vv && Array.isArray(vv.fixes)) fixList.push(...vv.fixes);
    else console.log(`  ⚠️ 纠错第 ${k / CH + 1} 批不可用，跳过`);
  }
  const v = { fixes: fixList };
  if (v && Array.isArray(v.fixes)) {
    let rejected = 0;
    const cand = [];
    for (const fx of v.fixes) {
      const i = fx && Number.isInteger(fx.id) ? fx.id : -1;
      if (i < 0 || i >= caps.length || typeof fx.text !== "string") { rejected++; continue; }
      const orig = caps[i].z, fixed = fx.text.trim();
      if (!fixed || fixed === orig) continue;
      if (Math.abs(fixed.length - orig.length) > 2) { rejected++; continue; }               // 长度突变 → 疑似改写
      if (lev(fixed, orig) > (R.corrections.maxEditPerLine ?? 8)) { rejected++; continue; }  // 改动过大 → 疑似改写
      cand.push({ id: i, from: orig, to: fixed, reason: fx.reason || "" });
    }
    // 拼音护栏:只接受"改动区读音相近"的修改(同音/近音替换),防 LLM 改写或幻觉
    let sims = null;
    if (cand.length) {
      const fi = path.join(EP, "work/_fix_in.json"), fo = path.join(EP, "work/_fix_out.json");
      fs.writeFileSync(fi, JSON.stringify(cand.map((r) => [r.from, r.to])));
      const chk = run(UV, ["run", "--with", "pypinyin", "python", path.join(ROOT, "firstcut/pinyin_check.py"), fi, fo], { env: ASR_ENV });
      if (chk.status === 0 && fs.existsSync(fo)) { try { sims = JSON.parse(fs.readFileSync(fo, "utf8")); } catch { /* 解析失败按不可用处理 */ } }
      if (!sims) console.log(`  ⚠️ 拼音校验不可用，本次纠错全部丢弃(保守): ${asrFail(chk)}`);
    }
    const MINSPAN = R.corrections.pinyinSimMin ?? 0.5;
    let applied = 0;
    const reps = [];
    for (let k = 0; k < cand.length; k++) {
      if (sims && !(sims[k] && sims[k].span >= MINSPAN)) { rejected++; continue; }
      const r = cand[k];
      reps.push(r); caps[r.id].z = r.to; applied++;
    }
    fs.writeFileSync(path.join(EP, "work/asr-fixes.json"), JSON.stringify({ applied, rejected, report: reps }, null, 1));
    console.log(`  纠错 ${applied} 行${rejected ? `，丢弃 ${rejected} 处疑似改写/不可信` : ""}（详见 work/asr-fixes.json）`);
    if (applied) fs.writeFileSync(capsPath, JSON.stringify(caps, null, 1));
  } else console.log("  ⚠️ 错字纠错不可用，保留原字幕");
}

// ── 4.5 字幕断行裁决（已弃用：改用 asr_and_caps.py 的 phraseAware DP，见 rules.caption）──
// 机械断行会产生 1~2 字碎行、或把词切开;分组重组能同时修这两类问题(逐行对切一刀做不到"合并")。
// 硬约束:只在组内重新划线、不增删字;输出拼接后必须等于原文,否则该组回退原样(防 LLM 改写)。
// 关闭方式:--no-ai 或 rules.arbiter.enabled=false;裁决明细落 work/break-verdicts.json。
if (!NO_AI && R.arbiter.enabled && (R.arbiter.kinds || []).includes("caption-break") && caps.length >= 2) {
  step(`字幕断行裁决（${R.arbiter.model}）`);
  const GROUP = R.arbiter.groupSize || 6;
  const MAXC = R.caption.maxCharsPerLine;
  const allG = [];
  for (let g = 0; g < caps.length; g += GROUP) allG.push({ id: g, seg: caps.slice(g, g + GROUP) });
  const send = allG.filter((x) => x.seg.length >= 2)
    .map((x) => ({ id: x.id, lines: x.seg.map((c) => c.z), text: x.seg.map((c) => c.z).join("") }));
  if (!send.length) console.log("  无可裁决的字幕组");
  else {
    const ap = fs.readFileSync(path.join(ROOT, "firstcut/arbiter-prompt.md"), "utf8")
      .replaceAll("{{MAX}}", String(MAXC))
      .replaceAll("{{GROUPS}}", JSON.stringify(send));
    const ax = runCli(LLM, ["-p", "--output-format", "text"],
      { input: ap, timeout: R.llm.timeoutMs, env: { ...process.env, XUNJIAN_DS_MODEL: R.arbiter.model } });
    const ao = ax.stdout || "";
    let judged = [];
    try { judged = (JSON.parse(ao.slice(ao.indexOf("{"), ao.lastIndexOf("}") + 1)).groups) || []; }
    catch { console.log(`  ⚠️ 裁决输出解析失败，保留原断行: ${(ao || "").trim().slice(0, 120)}`); }
    const byId = new Map(judged.map((x) => [x.id, x]));
    const out = [];
    let moved = 0, rej = 0;
    const report = [];
    for (const g of allG) {
      const orig = g.seg.map((c) => c.z);
      let parts = orig;
      const res = byId.get(g.id);
      if (res && Array.isArray(res.cuts) && res.cuts.length) {
        const txt = orig.join("");
        // 容错:过滤越界/非整数切点(实测 LLM 常把末尾 len 也塞进来)
        const cuts = [...new Set(res.cuts.filter((c) => Number.isInteger(c) && c > 0 && c < txt.length))]
          .sort((a, b) => a - b);
        const tooLong = cuts.some((c, i) => c - (i ? cuts[i - 1] : 0) > MAXC)
          || (txt.length - (cuts[cuts.length - 1] || 0)) > MAXC;
        if (!cuts.length || tooLong) rej++;
        else {
          const p = []; let pv = 0;
          for (const c of cuts) { p.push(txt.slice(pv, c)); pv = c; }
          p.push(txt.slice(pv));
          if (p.join("") === txt) {                 // 防改写:字符必须守恒
            if (p.join("|") !== orig.join("|")) { moved++; report.push({ id: g.id, from: orig, to: p, reason: res.reason || "" }); }
            parts = p;
          } else rej++;
        }
      }
      if (parts === orig) {                         // 未改动:时间原样保留
        g.seg.forEach((c) => out.push({ s: c.s, e: c.e, z: c.z }));
      } else {                                      // 改动:组内时间按字符比例重新分配
        const s0 = g.seg[0].s, e1 = g.seg[g.seg.length - 1].e;
        const tot = parts.join("").length || 1;
        let acc = s0;
        parts.forEach((t, i) => {
          const e = i === parts.length - 1 ? e1 : +(acc + (e1 - s0) * (t.length / tot)).toFixed(3);
          out.push({ s: +acc.toFixed(3), e: +e.toFixed(3), z: t });
          acc = e;
        });
      }
    }
    fs.writeFileSync(path.join(EP, "work/break-verdicts.json"),
      JSON.stringify({ groups: send.length, moved, rejected: rej, report }, null, 1));
    if (moved > 0) { caps = out; fs.writeFileSync(capsPath, JSON.stringify(caps, null, 1)); }
    console.log(`  裁决 ${send.length} 组 → 重组 ${moved} 组${rej ? `，丢弃 ${rej} 组非法输出` : ""}（详见 work/break-verdicts.json）`);
  }
}

// ── 5. 渲染器与依赖就位 ──
fs.copyFileSync(path.join(ROOT, "episodes/demo/gen.js"), path.join(EP, "gen.js"));
fs.copyFileSync(path.join(ROOT, "episodes/demo/package.json"), path.join(EP, "package.json"));
const gsap = path.join(ROOT, "episodes/demo/hf/assets/gsap.min.js");
if (fs.existsSync(gsap)) fs.copyFileSync(gsap, path.join(EP, "hf/assets/gsap.min.js"));

// ── 6. timeline：AI 初剪 或 骨架 ──
const boxes = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/timeline-template.json"), "utf8")).boxes ||
  { cam: { y: 0, h: 1920 }, chap: { y: 100 }, title: { y: 170 }, beat: { x: 76, y: 1020, w: 860 }, cap: { y: 1400 }, card: { x: 56, y: 260, w: 968, h: 470 } };
const skeleton = () => ({
  meta: { episode: NAME, name: NAME, layout: "V0-fx", title: "待定|标题|", dur: +dur.toFixed(2), durPreview: +dur.toFixed(2), cam: { full: camName, preview: camName }, capsFile: "work/caps-full.json" },
  boxes, chapters: [{ n: "01", lab: "全片", en: "ROUGH CUT", s: 0, e: +dur.toFixed(2) }], pops: [], cards: [], media: [], chipT: null,
});
let timeline = skeleton();
if (!NO_AI && !NO_AICUT && caps.length) {
  step(`AI 初剪（调用 ${LLM}，约 1-2 分钟）`);
  const prompt = fs.readFileSync(path.join(ROOT, "firstcut/ai-cut-prompt.md"), "utf8")
    .replaceAll("{{DUR}}", dur.toFixed(2)).replaceAll("{{EPISODE}}", NAME).replaceAll("{{CAM}}", camName)
    .replaceAll("{{BOXES}}", JSON.stringify(boxes)).replaceAll("{{CAPTIONS}}", JSON.stringify(caps));
  // 超时放宽到 15 分钟：GLM-5.3 等推理型网关对结构化任务可能耗时 5 分钟以上，
  // 原来 300000(5min) 会把还没输出完的进程 SIGTERM 掉 → stdout 为空 → 误判"AI 输出解析失败"。
  const ai = runCli(LLM, ["-p", "--output-format", "text"], { input: prompt, timeout: R.llm.timeoutMs });
  const out = ai.stdout || "";
  const j0 = out.indexOf("{"), j1 = out.lastIndexOf("}");
  try {
    const t = JSON.parse(out.slice(j0, j1 + 1));
    (t.cards || []).forEach((c, i) => { if (!c.id) c.id = "cx" + (i + 1); });
    (t.pops || []).forEach((p, i) => { if (!p.id) p.id = "p" + (i + 1); });
    t.meta = { ...skeleton().meta, ...t.meta, cam: { full: camName, preview: camName }, capsFile: "work/caps-full.json" };
    t.boxes = t.boxes || boxes;
    timeline = t;
    console.log(`  ✓ AI 初剪完成：${(t.chapters || []).length} 章节 / ${(t.pops || []).length} 弹字 / ${(t.cards || []).length} 卡片`);
  } catch {
    console.log("  ⚠️ AI 输出解析失败，落回骨架工程（编辑器里可用 ✨AI动效 逐段补）");
  }
} else if (!NO_AI) {
  console.log("  无字幕可供 AI 初剪，生成骨架工程");
}
fs.writeFileSync(path.join(EP, "timeline.json"), JSON.stringify(timeline, null, 1));

// ── 7. 生成预览页 ──
step("生成预览页");
r = run("node", ["gen.js"], { cwd: EP, env: { ...process.env, FULL: "1" } });
if (r.status !== 0) die("gen.js 失败: " + (r.stderr || r.stdout)?.slice(-300));
console.log("  " + (r.stdout || "").trim().split("\n").pop());

console.log(`\n✅ 初剪完成！接下来去定剪：
   npm run dev
   打开 http://127.0.0.1:5178/editor.html → 左上角选「${NAME}」
   （AI 剪的每个元素都在时间轴上，拖谁改谁——你说了算）`);
