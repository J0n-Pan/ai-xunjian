// 剪辑台前端 —— 无框架，只跟本机 /api 说话。
// 核心约定：审核决定只写 overrides.json，重剪走 reexport.mjs，永不重跑 ASR/LLM。

const $ = (id) => document.getElementById(id);
const api = async (p, opt = {}) => {
  const r = await fetch(p, opt);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
};
const postJSON = (p, obj) => api(p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj || {}),
});

const S = {
  cfg: null, file: null, name: null,
  projects: [], autoTried: new Set(),
  tl: null, review: [], decisions: {}, active: null, media: null,
  subCuts: [], subSel: null,   // 字幕条：自己标的「剪掉」区间 / 当前选中的第几句
  versions: [], curVer: 0, viewVer: 0,
  running: false, mode: "cut", src: "proxy", timer: null,
  range: null,
  rate: 1,                 // 播放倍速：跟着播放器走，切素材/切源都保留
  logOpen: false,          // 处理日志是否展开（展开才去拉完整日志）
  logText: "", logLines: [],
};

const KIND = {
  "filler-gap": ["语气词 · 留白不足", ""],
  "filler-syntax": ["语气词 · 句首尾", ""],
  "filler-demon": ["语气词 · 指示结构", ""],
  "filler-stick": ["语气词 · 紧贴", ""],
  "offtopic-mid": ["跑题 · 中段", "b"],
  "echo-tail": ["收尾呼应", "b"],
  "slip-noref": ["超长重说", "b"],
  "paraphrase-dir": ["换说法 · 方向", "b"],
  "paraphrase-short": ["换说法 · 过短", "b"],
  "dep-keep": ["前件保护", "b"],
  "logic-link": ["逻辑续接", "b"],
  "batch-over": ["批量超限", "r"],
};
const fmt = (t) => {
  t = Math.max(0, Number(t) || 0);
  const m = Math.floor(t / 60), s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// ui-20261009_C0793-080536 → 20261009_C0793
const prettyName = (n) => String(n || "").replace(/^ui-/, "").replace(/-\d{6}$/, "");

let toastTimer = null;
function toast(msg, isErr) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast on" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 2600);
}

// ───────────────────────── 配置 ─────────────────────────
async function loadConfig() {
  const c = await api("/api/config");
  S.cfg = c;
  $("keyDot").className = "live " + (c.hasKey ? "" : "off");
  $("keyState").textContent = c.hasKey ? "已连接" : "未配置";
  $("apiKey").placeholder = c.hasKey ? c.masked : "sk-...";
  $("modelName").textContent = c.model || "qwen-plus";
  paintExportPath();
}

function paintExportPath() {
  if (!S.cfg) return;
  // .env 里可能写成 C:/a/b（正斜杠）也可能写成 C:\a\b，统一显示成本机习惯的反斜杠
  let dir = (S.cfg.exportDir || "").replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:/.test(dir) || dir.includes("\\")) dir = dir.replace(/\//g, "\\");
  // 配置里的路径在这台机器上用不了（多半是目录从别的电脑整份拷过来）→ 明说，别让人对着空文件夹猜
  const w = $("pathWarn");
  if (S.cfg.exportDirFallback) {
    w.hidden = false;
    w.textContent = `配置里的路径「${S.cfg.exportDirWant || "空"}」在本机不可用，已临时改用 ${dir}。点「更改」重新选一个。`;
  } else {
    w.hidden = true;
  }
  if (!S.name) { $("exportPath").textContent = dir ? `${dir}\n（剪辑完成后生成 <任务名>.mp4）` : "—"; return; }
  // 正在回看旧版时显示该版的留档文件，避免「写着最新版路径、点开却是旧版」
  const viewingOld = (S.versions || []).length > 1 && S.viewVer && S.viewVer !== S.curVer;
  $("exportPath").textContent = `${dir}\\${S.name}${viewingOld ? `.v${S.viewVer}` : ""}.mp4`;
}

$("eye").onclick = () => {
  const i = $("apiKey");
  const show = i.type === "password";
  i.type = show ? "text" : "password";
  $("eye").textContent = show ? "隐藏" : "显示";
};

$("btnTest").onclick = async () => {
  const b = $("btnTest");
  b.disabled = true; b.textContent = "测试中…";
  try {
    const key = $("apiKey").value.trim();
    if (key) await postJSON("/api/config", { apiKey: key });
    const r = await postJSON("/api/config/test");
    b.textContent = r.ok ? `连通 ${r.ms}ms` : "连接失败";
    toast(r.ok ? `Key 可用（${r.ms}ms）` : `连接失败：${r.error}`, !r.ok);
    await loadConfig();
  } catch (e) { b.textContent = "连接失败"; toast(e.message, true); }
  setTimeout(() => (b.textContent = "测试连接", (b.disabled = false)), 1800);
};

$("btnSaveKey").onclick = async () => {
  const key = $("apiKey").value.trim();
  if (!key) return toast("先填入 Key", true);
  try {
    await postJSON("/api/config", { apiKey: key });
    await loadConfig();
    $("apiKey").value = "";
    toast("已写入本机 .env");
    // Key 是自动处理的前置条件：存好后把刚才被拦下的素材直接跑起来，不用再去点按钮
    if (!S.running && S.file && !S.tl) await autoStart(true);
  } catch (e) { toast(e.message, true); }
};

// ───────────────────────── 素材列表（顶栏下拉）─────────────────────────
// 一条素材 = 一个工程。下拉里始终是「所有上传过的素材」，点哪个就把版面换成哪个工程，
// 不是只看最近一条 —— 否则上传第二条时第一条就从界面上消失了。
function paintProjects() {
  const sel = $("projSel");
  const list = S.projects || [];
  if (!list.length) {
    sel.innerHTML = `<option value="">暂无素材</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  // 同名素材（同一个文件传了两次）会出现多条，光看标题分不清 → 这类补一个上传时刻
  const dup = {};
  list.forEach((p) => { dup[p.title] = (dup[p.title] || 0) + 1; });
  const hhmm = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
  };
  const label = (p) => {
    const d = p.dur ? `${p.dur.toFixed(0)}s` : "—";
    const st = p.state === "running" ? `处理中 ${p.pct || 0}%`
      : p.state === "idle" ? "待处理"
      : p.state === "failed" ? "失败"
      : p.out && p.out.dur ? `已初剪 ${p.out.dur.toFixed(0)}s` : "已初剪";
    const t = dup[p.title] > 1 ? ` ${hhmm(p.at)}` : "";
    return `${p.title}${t} · ${d} · ${st}`;
  };
  let html = list.map((p) =>
    `<option value="${esc(p.name)}"${p.name === S.name ? " selected" : ""}>${esc(label(p))}</option>`).join("");
  // 刚上传、列表请求还没回来时，先让当前素材在下拉里有个位置（否则显示成上一个项目）
  if (S.name && !list.some((p) => p.name === S.name)) {
    html = `<option value="${esc(S.name)}" selected>${esc(prettyName(S.name))} · 处理中</option>` + html;
  }
  sel.innerHTML = html;
}

async function loadProjects() {
  try {
    const r = await api("/api/projects");
    S.projects = r.items || [];
  } catch { /* 列表挂了不影响当前工程使用 */ }
  paintProjects();
  return S.projects;
}

// 清空「上一个素材」残留的版面：时间轴、审核项、版本下拉、预览画面
function resetProjectView() {
  S.tl = null; S.review = []; S.decisions = {}; S.active = null; S.media = null;
  S.versions = []; S.curVer = 0; S.viewVer = 0; S.range = null;
  S.subCuts = []; S.subSel = null;
  $("pins").innerHTML = ""; $("gaps").innerHTML = ""; $("ruler").innerHTML = ""; $("subs").innerHTML = "";
  $("subBar").hidden = true;
  $("statDur").textContent = "—"; $("statSegs").textContent = "—";
  $("stQueue").textContent = "—"; $("rvCount").textContent = "0 处";
  $("rvProg").textContent = "已确认 0 · 剩余 0";
  $("progOk").style.width = "0%"; $("progNo").style.width = "0%";
  $("verSel").hidden = true; $("verList").hidden = true;
  $("rvHint").hidden = true;
  $("btnRetry").hidden = true;
  $("stElapsed").textContent = "—";
  setLogs("");
  $("rlist").innerHTML = `<div class="emptyv">
    <svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-3-3m3 3l3-3M4 19h16"/></svg>
    还没有待确认项<br/>素材上传后会自动开始初剪</div>`;
  paintVersions();
  setStep(null);
  // 画面也要清，否则切到还没处理的素材时还挂着上一条的视频
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("pvEmpty").hidden = false;
  $("pvNote").hidden = true;
  S.src = "";
}

// ───────────────────────── 处理日志（折叠 / 展开）─────────────────────────
// 折叠时只露最新 6 行（省地方）；点标题展开后去 /api/logs 拉本次运行的**完整**日志。
// 轮询里的 st.logs 只带最后几个输出块，展开态不能拿它覆盖，否则一刷新就又变回几行。
function setLogs(text) {
  S.logText = String(text || "");
  S.logLines = S.logText.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  renderLogs();
}

function renderLogs() {
  const box = $("logs");
  const all = S.logLines;
  if (!all.length) {
    box.innerHTML = `<div><em>·</em><span>等待素材开始处理</span></div>`;
    return;
  }
  // 用户往上翻着看时不把他拽回底部（跑批时每 1.2s 重绘一次，否则根本没法读）
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 28;
  const keep = box.scrollTop;
  const lines = S.logOpen ? all : all.slice(-6);
  box.innerHTML = lines.map((l) => {
    const warn = /⚠️|✗|失败|错误/.test(l);
    return `<div><em>·</em><span class="${warn ? "warn" : ""}" title="${esc(l)}">${esc(l.replace(/^\s+/, ""))}</span></div>`;
  }).join("");
  if (S.logOpen) box.scrollTop = atBottom ? box.scrollHeight : keep;
}

async function loadFullLogs() {
  if (!S.name) return;
  try {
    const r = await api(`/api/logs?name=${encodeURIComponent(S.name)}`);
    if (r && typeof r.text === "string" && r.text.trim()) setLogs(r.text);
  } catch { /* 日志拿不到就保持现状，不打断审核 */ }
}

function paintLogOpen() {
  $("logCard").classList.toggle("open", S.logOpen);
  const b = $("btnLogToggle");
  b.textContent = S.logOpen ? "收起" : "展开";
  b.setAttribute("aria-expanded", String(S.logOpen));
  $("logHead").title = S.logOpen ? "点击收起日志" : "点击展开完整日志";
  renderLogs();
}

async function toggleLogs(force) {
  const next = force == null ? !S.logOpen : !!force;
  if (next === S.logOpen) return;
  S.logOpen = next;
  localStorage.setItem("studio.logOpen", S.logOpen ? "1" : "0");
  paintLogOpen();
  if (S.logOpen) {
    await loadFullLogs();
    // 日志卡在左栏最底下，展开后会长出可视区 —— 自动滚到能看全的位置
    try { $("logCard").scrollIntoView({ block: "end", behavior: "smooth" }); } catch {}
  }
}

$("btnLogToggle").onclick = (e) => { e.stopPropagation(); toggleLogs(); };
$("logHead").onclick = () => toggleLogs();

$("projSel").onchange = (e) => switchProject(e.target.value);

async function switchProject(name) {
  if (!name || name === S.name) return;
  clearInterval(S.timer); S.timer = null; S.running = false;
  S.name = name;
  localStorage.setItem("studio.name", name);
  resetProjectView();
  paintExportPath();
  await restore(name);
  paintProjects();
}

// ───────────────────────── 上传 ─────────────────────────
const drop = $("drop");
drop.onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => e.target.files[0] && upload(e.target.files[0]);
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.add("over");
}));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.remove("over");
}));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) upload(f);
});

async function upload(file) {
  const meta = $("fMeta");
  $("fileCard").hidden = false;
  $("fName").textContent = file.name;
  meta.textContent = "上传中…";
  try {
    const r = await api("/api/upload", {
      method: "POST",
      headers: { "x-filename": encodeURIComponent(file.name) },
      body: file,
    });
    // 换素材 = 换工程，上一个工程的画面/时间轴/审核项不能留在版面上
    S.file = r.file;
    S.name = r.key;
    localStorage.setItem("studio.name", r.key);
    resetProjectView();
    meta.innerHTML = `<i class="tag">${r.vertical ? "竖屏" : "横屏"} ${r.w}×${r.h}</i>${r.dur.toFixed(1)}s · ${(r.size / 1048576).toFixed(1)} MB`;
    paintExportPath();
    setStep("upload");
    // 立刻出画面：先直出原片，代理转好再自动切
    ensurePreview();
    // 下拉里立刻出现这条素材（上传即入列）
    await loadProjects();
    await autoStart();
  } catch (e) {
    meta.textContent = "上传失败：" + e.message;
    toast("上传失败：" + e.message, true);
  }
}

// ───────────────────────── 自动开跑 ─────────────────────────
// 没有「开始剪辑」按钮：素材上传完成就自动跑第一轮。
// 唯一的前置条件是 API Key —— 没配就先留住素材，配好再去 autoStart。
async function autoStart(fromSave = false) {
  if (!S.name || !S.file) return;
  if (S.running) return;
  if (!S.cfg || !S.cfg.hasKey) {
    setLogs("素材已保存，但还没配置 API Key —— 填好并保存后会自动开始");
    setStatus("待配置 Key", "● 暂停", "warn");
    return;
  }
  if (!fromSave && S.autoTried.has(S.name)) return;
  S.autoTried.add(S.name);
  await runCut();
}

async function runCut() {
  if (!S.name || !S.file) return toast("先上传素材", true);
  if (!S.cfg || !S.cfg.hasKey) return toast("先保存 API Key", true);
  if (S.running) return;
  $("btnRetry").hidden = true;
  try {
    await postJSON("/api/run", { file: S.file, name: S.name });
    S.running = true;
    S.mode = "cut";
    setStatus("启动中", "● 运行中", "warn");
    pollStart();
  } catch (e) {
    toast(e.message, true);
    $("btnRetry").hidden = false;
  }
}

// ───────────────────────── 「AI 剪辑」重跑 ─────────────────────────
// 语义：对**上传的原片**再跑一轮（不是对当前成片）。当前版本会被冻结保留，新结果记为下一版。
// 同一素材 + 同模型 + temperature=0 时结果通常一样，所以这里给一个可选的补充要求输入框。
function openAiModal() {
  if (!S.name) return toast("先上传素材", true);
  if (S.running) return toast("正在处理，等它跑完再点", true);
  $("aiNote").value = "";
  $("aiHint").textContent = S.curVer
    ? `当前 v${S.curVer} 保留 · 新结果记为 v${S.curVer + 1}`
    : "还没有成片，这次会作为首剪";
  $("aiModal").hidden = false;
  setTimeout(() => $("aiNote").focus(), 0);
}
function closeAiModal() { $("aiModal").hidden = true; }
$("btnAiCut").onclick = openAiModal;
$("aiClose").onclick = closeAiModal;
$("aiCancel").onclick = closeAiModal;
$("aiModal").addEventListener("mousedown", (e) => { if (e.target === $("aiModal")) closeAiModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("aiModal").hidden) closeAiModal();
});

$("aiGo").onclick = async () => {
  const b = $("aiGo");
  if (b.disabled) return;
  b.disabled = true; b.textContent = "启动中…";
  try {
    const r = await postJSON("/api/recut", {
      name: S.name,
      note: $("aiNote").value.trim(),
      keepDecisions: $("aiKeep").checked,
    });
    closeAiModal();
    // 重跑=换了一套基线：清掉版面状态，等新结果回来再由 poll 填
    S.running = true; S.mode = "cut";
    S.tl = null; S.review = []; S.decisions = {}; S.active = null;
    S.subCuts = []; S.subSel = null; $("subs").innerHTML = ""; $("subBar").hidden = true;
    setStatus(`重跑中 v${r.from || 1} → v${r.to}`, "● 运行中", "warn");
    toast(`已开始重跑，结果会是 v${r.to}`);
    pollStart();
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false; b.textContent = "开始重跑";
  }
};

$("btnRetry").onclick = (e) => {
  e.stopPropagation();          // 别让点「重试」顺带把日志卡收起/展开
  if (!S.name) return;
  S.autoTried.delete(S.name);
  runCut();
};

// ───────────────────────── 轮询 ─────────────────────────
function pollStart() {
  clearInterval(S.timer);
  S.timer = setInterval(tick, 1200);
  tick();
}

async function tick() {
  if (!S.name) return;
  try {
    const st = await api(`/api/state?name=${encodeURIComponent(S.name)}`);
    paintState(st);
    if (S.logOpen) await loadFullLogs();   // 展开着看日志时，跟着跑批刷新完整日志
    if (!st.running) {
      clearInterval(S.timer);
      S.timer = null;
      S.running = false;
      await loadProjects();     // 下拉里的状态（待处理 → 已初剪 / 失败）要跟着变
      if (st.exitCode === 0) {
        if (S.mode === "reexport") {
          await loadTimeline();          // 版本链与时长按新决定重算，决定状态也从 overrides 恢复
          setSrc("out", true);
          const v = S.curVer ? ` v${S.curVer}` : "";
          toast(`已按你的决定重剪完成${v} · 上一版仍在，可下拉对比`);
          setStatus("重剪完成", "● 就绪", "ok");
        } else {
          await loadTimeline();
          setSrc("out", true);
          toast(`初剪完成 · ${st.reviewCount ?? 0} 条待确认`);
          setStatus("待审核", "● 就绪", "ok");
        }
      } else {
        toast(st.error || "处理失败，看日志", true);
        setStatus("失败", "● 失败", "warn");
        $("btnRetry").hidden = false;
      }
    }
  } catch (e) {
    clearInterval(S.timer); S.timer = null; S.running = false;
    toast(e.message, true);
  }
}

function paintState(st) {
  $("stStage").textContent = st.stage || "—";
  $("stElapsed").textContent = st.elapsed ? `${Math.floor(st.elapsed / 60)}m${String(st.elapsed % 60).padStart(2, "0")}s` : "—";
  $("stQueue").textContent = st.reviewCount == null ? "—" : `${st.reviewCount} 条`;
  // 日志：折叠态用轮询带回的尾部几行；展开态由 /api/logs 提供完整日志（这里不能覆盖）
  if (!S.logOpen) setLogs(st.logs || "");
  // 步骤
  const pct = st.pct || 0;
  if (pct >= 5) setStep("upload");
  if (pct >= 22) setStep("asr");
  if (pct >= 72) setStep("judge");
  if (st.done && st.exitCode === 0) setStep(S.mode === "reexport" ? "export" : "review");
  if (st.outDur) $("statDur").innerHTML = `${st.outDur.toFixed(1)}<small>s</small>`;
}

function setStep(k) {
  const order = ["upload", "asr", "judge", "review", "export"];
  const idx = order.indexOf(k);
  document.querySelectorAll("#steps .step").forEach((el) => {
    const i = order.indexOf(el.dataset.k);
    el.className = "step" + (i < idx ? " done" : i === idx ? " cur" : "");
  });
}
function setStatus(stage, ready, cls) {
  $("stStage").textContent = stage;
  $("stReady").textContent = ready;
  $("stReady").className = cls || "ok";
}

// ───────────────────────── 时间轴 ─────────────────────────
// 决定 ↔ 审核项的匹配：只看时间区间，不看 id（id 是序号，重跑就全变了）
function decisionFor(item, decisions) {
  const len = Math.max(0.001, (item.e || 0) - (item.s || 0));
  let best = null, bestOv = 0;
  for (const d of decisions) {
    if (!d || d.choice == null) continue;
    // 字幕条标的剪切是「手剪」，不参与审核项的回显，否则会把某条审核项错判成已确认
    if (d.kind === "sub") continue;
    for (const r of d.cuts || []) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const ov = Math.min(item.e, r[1]) - Math.max(item.s, r[0]);
      if (ov > bestOv) { bestOv = ov; best = d; }
    }
  }
  // 覆盖不到一半就当作没做过决定：宁可显示"待确认"，也别把相邻句子的决定错配过来
  return bestOv >= Math.max(0.15, len * 0.5) ? best : null;
}

async function loadTimeline(syncVer = true) {
  const tl = await api(`/api/timeline?name=${encodeURIComponent(S.name)}`);
  S.tl = tl;
  S.versions = tl.versions || [];
  S.curVer = tl.curVer || 0;
  // 默认跟到最新版；只有在明确回看旧版时才保留（避免每次重算时间轴都把用户拽回最新）
  const known = S.versions.some((x) => x.v === S.viewVer);
  if (syncVer || !known) S.viewVer = S.curVer;
  S.review = (tl.review || []).slice().sort((a, b) =>
    (a.priority || 9) - (b.priority || 9) || a.s - b.s);
  S.decisions = {};
  // 「AI 剪辑」重跑后审核项会重新编号（id = 序号），按 id 回显会把决定显示到别的句子上。
  // 所以只按「时间区间重叠」匹配：决定里记的是要剪掉的 [a,b]，审核项也有自己的 [s,e]。
  for (const it of S.review) {
    const d = decisionFor(it, tl.decisions || []);
    if (d) S.decisions[it.id] = d.choice;
  }
  S.active = S.review.length ? S.review[0].id : null;
  // 字幕条的手剪区间从 overrides.json 回读：刷新页面不该丢掉刚标的段落
  S.subCuts = (tl.decisions || [])
    .filter((d) => d && d.kind === "sub" && d.choice === "cut")
    .flatMap((d) => (d.cuts || []).filter((r) => Array.isArray(r) && r.length === 2).map((r) => [+r[0], +r[1]]));
  S.subSel = null;
  $("subBar").hidden = true;
  $("stQueue").textContent = `${S.review.length} 条`;
  $("rvCount").textContent = `${S.review.length} 处`;
  paintRuler();
  paintSubs();
  paintSubStat();
  paintGaps();
  paintPins();
  paintReview();
  paintProgress();
  paintVersions();
  paintVerStats();
  paintExportPath();
}

// 统计卡跟着「正在看的那一版」走；顺带在两者不一致时说明原因
function paintVerStats() {
  const cur = (S.versions || []).find((x) => x.v === S.viewVer);
  const dur = cur && cur.dur ? cur.dur : S.tl ? S.tl.outDur : null;
  const segs = cur && cur.segs ? cur.segs : S.tl ? S.tl.segs.length : null;
  if (dur != null) $("statDur").innerHTML = `${dur.toFixed(1)}<small>s</small>`;
  if (segs != null) $("statSegs").innerHTML = `${segs}<small>段</small>`;

  const want = S.tl ? S.tl.outDur : null;
  const hint = $("rvHint");
  if (want != null && dur != null && Math.abs(want - dur) > 0.35) {
    hint.hidden = false;
    hint.innerHTML = `当前决定合计 <b>${want.toFixed(1)}s</b>，和你正在看的 v${S.viewVer}（${dur.toFixed(1)}s）不同 —— 点「应用并重剪」按当前决定生成新版本`;
  } else {
    hint.hidden = true;
  }
}

// 版本切换器：只有 2 版以上才出现。切换只改「看哪一版」，不影响当前决定。
function paintVersions() {
  const list = S.versions || [];
  const multi = list.length > 1;
  const sel = $("verSel");
  const box = $("verList");
  sel.hidden = !multi;
  box.hidden = !multi;
  if (!multi) { sel.innerHTML = ""; box.innerHTML = ""; return; }

  sel.innerHTML = list.map((x) => {
    const d = x.dur ? `${x.dur.toFixed(1)}s` : "—";
    const tag = x.v === S.curVer ? " · 最新" : x.kind === "cut" ? " · 首剪" : "";
    return `<option value="${x.v}"${x.v === S.viewVer ? " selected" : ""}>v${x.v} ${d}${tag}</option>`;
  }).join("");

  box.innerHTML = list.map((x) => {
    const d = x.dur ? `${x.dur.toFixed(1)}s` : "—";
    const note = x.note || (x.kind === "cut" ? "首剪" : `第 ${x.v} 版`);
    return `<div class="v${x.v === S.viewVer ? " on" : ""}${x.v === S.curVer ? " now" : ""}" data-v="${x.v}" title="${esc(note)}">
      <b>v${x.v}</b><i>${d}</i><span>${esc(x.v === S.curVer ? "最新 · " + note : note)}</span></div>`;
  }).join("");
  box.querySelectorAll(".v").forEach((el) => {
    el.onclick = () => pickVersion(Number(el.dataset.v));
  });
}

function pickVersion(v) {
  if (!v || v === S.viewVer) return;
  S.viewVer = v;
  paintVersions();
  paintVerStats();
  paintExportPath();
  setSrc("out", true);
  const it = (S.versions || []).find((x) => x.v === v);
  toast(`预览 v${v}${it && it.dur ? ` · ${it.dur.toFixed(1)}s` : ""}`);
}

function paintRuler() {
  if (!S.tl) return;
  const n = 6;
  $("ruler").innerHTML = Array.from({ length: n }, (_, i) =>
    `<span>${fmt((S.tl.rawDur * i) / (n - 1)).replace(/\.\d$/, "")}</span>`).join("");
}

function paintGaps() {
  if (!S.tl) return;
  const dur = S.tl.rawDur || 1;
  $("gaps").innerHTML = S.tl.gaps.map(([a, b]) =>
    `<i style="left:${(a / dur) * 100}%;width:${((b - a) / dur) * 100}%"></i>`).join("");
}

// ── 字幕条 ──
// 铺的是「原片逐句字幕」（raw-segs），不是保留段：已剪的句子也要在，否则看不出某句为什么不见了。
// 三种状态：可剪 / alg（算法已剪，灰掉不可点）/ cut（自己标的剪掉，等「应用并重剪」落盘）
function subKeptLen(x) {
  let n = 0;
  for (const [a, b] of S.tl.baseSegs || []) n += Math.max(0, Math.min(x.e, b) - Math.max(x.s, a));
  return n;
}
const subIsAlg = (x) => subKeptLen(x) < (x.e - x.s) * 0.55;
const subIsCut = (x) => S.subCuts.some(([a, b]) =>
  Math.min(x.e, b) - Math.max(x.s, a) > (x.e - x.s) * 0.5);

function paintSubs() {
  const box = $("subs");
  const list = (S.tl && S.tl.subs) || [];
  if (!list.length) { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  const dur = S.tl.rawDur || 1;
  const W = box.clientWidth || 0;
  box.innerHTML = list.map((x, i) => {
    const alg = subIsAlg(x);
    const cut = !alg && subIsCut(x);
    const cls = ["s", alg ? "alg" : "", cut ? "cut" : "", i === S.subSel ? "on" : ""].filter(Boolean).join(" ");
    const l = (x.s / dur) * 100, w = ((x.e - x.s) / dur) * 100;
    // 切细之后很多块只有十几像素宽，字塞进去只剩半个偏旁 —— 放不下就不放，全文留在 title 里
    const pw = (w / 100) * W;
    const label = pw >= 26 ? esc(x.z) : pw >= 13 ? esc(x.z.slice(0, 1)) : "";
    return `<div class="${cls}" data-i="${i}" style="left:calc(${l}% + 1px);width:calc(${w}% - 2px)"
      title="${esc(`${fmt(x.s)}–${fmt(x.e)} · ${x.z}`)}">${label}</div>`;
  }).join("");
}

function paintSubBar() {
  const x = S.tl && S.subSel != null ? (S.tl.subs || [])[S.subSel] : null;
  if (!x) { $("subBar").hidden = true; return; }
  const cut = subIsCut(x);
  $("subBar").hidden = false;
  $("subInfo").innerHTML =
    `<b>${fmt(x.s)}–${fmt(x.e)}</b> · ${esc(x.z.slice(0, 40))}${x.z.length > 40 ? "…" : ""}`;
  $("subToggle").textContent = cut ? "恢复这段" : "剪掉这段";
}

// 顶部统计：已标几段、合计多少秒（只标记不落盘，所以要说清"待剪"）
function paintSubStat() {
  const el = $("subStat");
  if (!el) return;
  const n = S.subCuts.length;
  if (!n) { el.hidden = true; el.textContent = ""; return; }
  const sec = S.subCuts.reduce((a, [s, e]) => a + (e - s), 0);
  el.hidden = false;
  el.textContent = `字幕条已标 ${n} 段 · 待剪 ${sec.toFixed(1)}s`;
}

function selectSub(i) {
  const x = S.tl && (S.tl.subs || [])[i];
  if (!x) return;
  if (subIsAlg(x)) return toast("这段已经被算法剪掉了");
  S.subSel = S.subSel === i ? null : i;
  paintSubs(); paintSubBar();
  if (S.subSel != null) seekTo(x.s + 0.05);
}

function toggleSubCut() {
  const x = S.tl && S.subSel != null ? (S.tl.subs || [])[S.subSel] : null;
  if (!x) return;
  if (subIsCut(x)) {
    S.subCuts = S.subCuts.filter(([a, b]) => Math.min(x.e, b) - Math.max(x.s, a) <= (x.e - x.s) * 0.5);
    toast("已恢复这段");
  } else {
    S.subCuts.push([+x.s.toFixed(3), +x.e.toFixed(3)]);
    toast(`已标记剪掉 ${fmt(x.s)}–${fmt(x.e)} —— 点「应用并重剪」才生效`);
  }
  paintSubs(); paintSubBar(); paintSubStat();
}

function paintPins() {
  if (!S.tl) return;
  const dur = S.tl.rawDur || 1;
  $("pins").innerHTML = S.review.map((it, i) => {
    const mid = (it.s + it.e) / 2;
    const d = S.decisions[it.id];
    const cls = it.id === S.active ? "on" : d === "cut" ? "cut" : d === "keep" ? "keep" : "";
    return `<div class="pin ${cls}" style="left:${(mid / dur) * 100}%" data-id="${it.id}" title="${esc(it.text || "")}">
      <span class="st"></span><span class="lb">${i + 1}</span></div>`;
  }).join("");
  $("pins").querySelectorAll(".pin").forEach((el) => {
    el.onclick = () => selectItem(Number(el.dataset.id), true);
  });
}

function paintReview() {
  const box = $("rlist");
  if (!S.review.length) {
    box.innerHTML = `<div class="emptyv"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
      没有需要你拍板的地方<br/><span style="color:#3F485C">算法对这批剪切是有把握的</span></div>`;
    return;
  }
  box.innerHTML = S.review.map((it, i) => {
    const [label, tagCls] = KIND[it.kind] || [it.kind, ""];
    const d = S.decisions[it.id];
    const cls = it.id === S.active ? "on" : d === "cut" ? "cut" : d === "keep" ? "keep" : "";
    const line = it.line || it.text || "";
    const hl = it.text && line.includes(it.text)
      ? esc(line).replace(esc(it.text), `<span class="hl">${esc(it.text)}</span>`)
      : esc(line);
    const llm = it.llm || {}, g = it.guard || {};
    const gv = g.value === undefined || g.value === "" ? "" : `${g.value}`;
    return `<article class="q ${cls}" data-id="${it.id}">
      <div class="qh">
        <span class="tag2 ${tagCls}">${esc(label)}</span>
        <span class="id">#${i + 1}</span>
        <span class="tt">${fmt(it.s)} · ${(it.e - it.s).toFixed(2)}s</span>
      </div>
      <div class="qt">${hl}</div>
      <div class="why"><b>模型判「删」</b>（${esc(llm.reason || "—")}）· <b>护栏判「留」</b>（${esc(g.rule || "")}${gv ? " " + esc(gv) : ""}${g.limit ? " / 阈值 " + esc(g.limit) : ""}）<br/>${esc(it.question || "")}</div>
      <div class="acts">
        <button class="a del ${d === "cut" ? "on" : ""}" data-act="cut">删掉</button>
        <button class="a keep ${d === "keep" ? "on" : ""}" data-act="keep">保留</button>
        <button class="a ghost" data-act="listen">听上下文</button>
        <button class="a k">D / K</button>
      </div>
    </article>`;
  }).join("");
  box.querySelectorAll(".q").forEach((el) => {
    const id = Number(el.dataset.id);
    el.onclick = (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "cut") return decide(id, "cut");
      if (act === "keep") return decide(id, "keep");
      if (act === "listen") return selectItem(id, true);
      selectItem(id, false);
    };
  });
}

function paintProgress() {
  const total = S.review.length || 1;
  const yes = Object.values(S.decisions).filter((v) => v === "cut").length;
  const no = Object.values(S.decisions).filter((v) => v === "keep").length;
  $("progOk").style.width = `${(yes / total) * 100}%`;
  $("progNo").style.width = `${(no / total) * 100}%`;
  $("rvProg").textContent = `已确认 ${yes + no} · 剩余 ${total - yes - no}`;
}

// ───────────────────────── 交互 ─────────────────────────
function selectItem(id, listen) {
  const it = S.review.find((x) => x.id === id);
  if (!it) return;
  S.active = id;
  paintPins(); paintReview(); paintProgress();
  if (listen) playRange(it.s - 1.5, it.e + 1.5);
  else seekTo(it.s - 0.6);
}

function decide(id, choice) {
  S.decisions[id] = choice;
  paintPins(); paintReview(); paintProgress();
  const next = S.review.find((x) => S.decisions[x.id] == null);
  if (next) selectItem(next.id, true);
  else toast("这一批都确认了，可以「应用并重剪」");
}

$("btnAcceptAll").onclick = () => {
  S.review.forEach((it) => { if (S.decisions[it.id] == null) S.decisions[it.id] = "keep"; });
  paintPins(); paintReview(); paintProgress();
  toast("已按建议全部保留（默认动作）");
};

$("btnApply").onclick = async () => {
  if (!S.name || !S.tl) return toast("先跑一次剪辑", true);
  const decisions = S.review
    .filter((it) => S.decisions[it.id])
    .map((it) => {
      const opt = (it.options || []).find((o) => (S.decisions[it.id] === "cut" ? o.label !== "保留" && o.label !== "保持不剪" : o.label === "保留" || o.label === "保持不剪"));
      return { id: it.id, kind: it.kind, choice: S.decisions[it.id], cuts: opt ? opt.cuts : [] };
    });
  // 字幕条标的区间一起落盘。带 kind=sub 是为了回读时不被当成某条审核项的决定
  for (const [s, e] of S.subCuts) decisions.push({ kind: "sub", choice: "cut", cuts: [[s, e]] });
  try {
    await postJSON("/api/decisions", { name: S.name, decisions });
    S.running = true;
    S.mode = "reexport";
    $("btnApply").disabled = true;
    setStatus("重剪中", "● 运行中", "warn");
    await postJSON("/api/reexport", { name: S.name });
    pollStart();
    setTimeout(() => ($("btnApply").disabled = false), 4000);
  } catch (e) { toast(e.message, true); $("btnApply").disabled = false; }
};

// ───────────────────────── 播放器 ─────────────────────────
const video = $("video");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SRC_LABEL = { raw: "原片", proxy: "原片", out: "成片" };
let errCount = 0;

function pvNote(html, warn) {
  const el = $("pvNote");
  if (!html) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.className = "pvnote" + (warn ? " warn" : "");
  el.innerHTML = html;
}

function setSrc(kind, force) {
  if (!S.name) return;
  // 同一个源且已经有 src 就不重挂，否则会把播放进度打断（重导出后要刷新，传 force）
  if (!force && kind === S.src && video.src) return;
  // 只有同一条时间线（原片↔代理 / 成片↔成片）才把进度带过去；
  // 原片 ↔ 成片 是两套时间轴，硬带会跳到完全无关的位置
  const sameLine = (S.src === "out") === (kind === "out");
  const t = sameLine ? (video.currentTime || 0) : 0;
  S.src = kind;
  $("pvBadge").textContent = SRC_LABEL[kind] || "原片";
  const tabSrc = kind === "out" ? "out" : "proxy";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.src === tabSrc));
  $("pvEmpty").hidden = true;
  const ver = kind === "out" ? `&v=${S.viewVer || 0}` : "";
  if (kind === "out") {
    const poster = `/api/poster?name=${encodeURIComponent(S.name)}&src=out&v=${S.viewVer || 0}`;
    video.poster = poster;
    // 元数据还没到时先按封面比例撑住版式，避免 300×150 默认框把版面跳一下
    const img = new Image();
    img.onload = () => { if (S.src === "out") video.style.aspectRatio = `${img.naturalWidth}/${img.naturalHeight}`; };
    img.src = poster;
  } else {
    video.poster = "";
    video.style.aspectRatio = "";
  }
  // 时长先用已知的计划值兜底，元数据到了会被 onloadedmetadata 覆盖
  if (S.tl) $("tcAll").innerHTML = `<em>/</em> ${fmt(kind === "out" ? S.tl.outDur : S.tl.rawDur).replace(/\.(\d)$/, "<em>.$1</em>")}`;
  video.src = `/api/video?name=${encodeURIComponent(S.name)}&src=${kind}${ver}`;
  video.load();
  applyRate();      // load() 会把倍速打回 1×，切源后要把用户选的倍速捡回来
  video.addEventListener("loadedmetadata", function once() {
    video.removeEventListener("loadedmetadata", once);
    // 原片 ↔ 代理 是同一条时间线，切换时把进度带过去，用户不会觉得画面被重置
    if (t > 0.3) video.currentTime = Math.min(t, video.duration || t);
  });
}

// 把预览挂起来：先立刻出原片（不依赖转码），代理转好再无缝切过去。
// 之所以要「等」：代理是边转边写的，转码期间去读会拿到没有 moov 的半截文件，
// 浏览器直接 error 且不会自己恢复 —— 这正是「上传后预览黑屏」的根因。
let pvSeq = 0;
async function ensurePreview() {
  if (!S.name) return;
  const seq = ++pvSeq;
  const q = `/api/media?name=${encodeURIComponent(S.name)}`;
  let m = null;
  try { m = await api(q); } catch { m = null; }
  if (seq !== pvSeq) return;
  S.media = m;
  errCount = 0;

  if (m && m.proxy.ready) { setSrc("proxy", true); pvNote(""); return; }
  if (m && m.raw.ready) {
    setSrc("raw", true);
    pvNote(`正在生成精准预览（${m.proxy.pct || 0}%）· 现在看的是原片，审核拖动会略糙`);
  } else {
    pvNote("素材还在准备，稍等…");
  }

  for (let i = 0; i < 400; i++) {
    await sleep(900);
    if (seq !== pvSeq) return;
    let st;
    try { st = await api(q); } catch { continue; }
    if (seq !== pvSeq) return;
    S.media = st;
    if (st.proxy.ready) {
      const wasPlaying = !video.paused && !video.ended && !!video.src;
      setSrc("proxy", true);
      if (wasPlaying) video.addEventListener("loadedmetadata", () => video.play().catch(() => {}), { once: true });
      pvNote("");
      return;
    }
    if (st.proxy.err) {
      pvNote(`精准预览没生成成功，先用原片顶上：${esc(st.proxy.err)}`, true);
      return;
    }
    if (st.raw.ready && S.src !== "raw") setSrc("raw", true);
    pvNote(`正在生成精准预览（${st.proxy.pct || 0}%）· 现在看的是原片，审核拖动会略糙`);
  }
}

document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.src === "out") {
      if (!S.tl && !S.curVer) return toast("还没有成片", true);
      setSrc("out", true);
      return;
    }
    // 「原片」优先给代理（seek 精准）；代理没好就退回直出原片，别按了个没反应的按钮
    const m = S.media;
    if (m && m.proxy.ready) { setSrc("proxy"); pvNote(""); }
    else if (m && m.raw.ready) { setSrc("raw"); pvNote("精准预览还在生成，先看原片 · 拖动会略糙"); }
    else ensurePreview();
    paintPins();
  };
});
$("verSel").onchange = (e) => pickVersion(Number(e.target.value));

$("btnPlay").onclick = () => {
  if (!video.src) return;
  if (video.paused) video.play(); else video.pause();
};
video.onplay = () => $("btnPlay").classList.add("pause");
video.onpause = () => $("btnPlay").classList.remove("pause");

// 审核播放用哪个源：代理就绪就用代理（seek 准），否则退回原片
const reviewSrc = () => (S.media ? (S.media.proxy.ready ? "proxy" : "raw") : "proxy");

function seekTo(t) {
  if (!video.src) return;
  if (S.src !== reviewSrc()) setSrc(reviewSrc());
  const go = () => { video.currentTime = Math.max(0, Math.min(t, video.duration || t)); };
  if (video.readyState >= 1) go(); else video.addEventListener("loadedmetadata", go, { once: true });
}

function playRange(a, b) {
  if (!video.src) return;
  if (S.src !== reviewSrc()) setSrc(reviewSrc());
  S.range = [Math.max(0, a), Math.max(a + 0.4, b)];
  const start = () => {
    video.currentTime = Math.max(0, a);
    video.play().catch(() => {});
  };
  if (video.readyState >= 1) start(); else video.addEventListener("loadedmetadata", start, { once: true });
}

video.ontimeupdate = () => {
  const d = video.duration || 1;
  const p = (video.currentTime / d) * 100;
  $("scrubFill").style.width = p + "%";
  $("scrubDot").style.left = p + "%";
  $("tcNow").innerHTML = fmt(video.currentTime).replace(/\.(\d)$/, "<em>.$1</em>");
  if (S.range && video.currentTime >= S.range[1]) { video.pause(); S.range = null; }
  if (S.src !== "out" && S.tl) {
    $("playhead").style.left = `${(video.currentTime / (S.tl.rawDur || 1)) * 100}%`;
  }
};
video.onloadedmetadata = () => {
  errCount = 0;
  $("tcAll").innerHTML = `<em>/</em> ${fmt(video.duration).replace(/\.(\d)$/, "<em>.$1</em>")}`;
  applyRate();
};
video.onerror = () => {
  // 切换素材时会主动清掉 src，此时 error(4) 是预期内的，别当成加载失败去重试
  if (!video.getAttribute("src")) return;
  const e = video.error;
  const code = e ? e.code : 0;
  // 源还没准备好（刚上传/刚剪完文件还在收尾）→ 退避重试；只有连续失败才报错。
  // 之前是失败一次就 toast，用户看到的就是「上传后预览一直加载不出来」。
  if (S.name && errCount < 5) {
    errCount++;
    const wait = 800 * errCount;
    pvNote(`预览加载失败（${code}），${(wait / 1000).toFixed(1)}s 后重试 ${errCount}/5`, true);
    setTimeout(() => { if (S.name) setSrc(S.src, true); }, wait);
    return;
  }
  pvNote("");
  toast(`预览加载失败${code ? `（${code}）` : ""}，可在「导出地址」里打开成片`, true);
};

$("scrub").onclick = (e) => {
  if (!video.src) return;
  const r = e.currentTarget.getBoundingClientRect();
  const f = (e.clientX - r.left) / r.width;
  video.currentTime = f * (video.duration || 0);
};

// ───────────────────────── 播放倍速 ─────────────────────────
// 审核时 1.25×/1.5× 听语气词最省时间，慢速用来听切口。
// 注意 video.load() 会把 playbackRate 复位成 defaultPlaybackRate，所以两个都要设。
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
function applyRate() {
  try {
    video.defaultPlaybackRate = S.rate;
    video.playbackRate = S.rate;
  } catch { /* 元数据没到时设了也不生效，onloadedmetadata 里会再设一次 */ }
}
function paintRate() {
  const b = $("btnRate");
  b.textContent = `${S.rate}×`;
  b.classList.toggle("on", S.rate !== 1);
  b.title = S.rate === 1
    ? "播放倍速 1×（点击切换，右键复位）"
    : `播放倍速 ${S.rate}×（点击继续切换，右键复位 1×）`;
}
function setRate(r, quiet) {
  const v = RATES.includes(Number(r)) ? Number(r) : 1;
  S.rate = v;
  localStorage.setItem("studio.rate", String(v));
  applyRate();
  paintRate();
  if (!quiet) toast(`播放倍速 ${v}×`);
}
$("btnRate").onclick = () => {
  const i = RATES.indexOf(S.rate);
  setRate(RATES[(i + 1) % RATES.length]);
};
$("btnRate").oncontextmenu = (e) => {
  e.preventDefault();
  if (S.rate !== 1) setRate(1); else toast("已经是 1×");
};

$("track").onclick = (e) => {
  if (!S.tl) return;
  const r = e.currentTarget.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  seekTo(f * S.tl.rawDur);
};

// 字幕条：单击选中并定位、双击直接标/撤「剪掉」、Delete 同效（手不用离开键盘）
$("subs").addEventListener("click", (e) => {
  const el = e.target.closest(".s");
  if (el) selectSub(Number(el.dataset.i));
});
$("subs").addEventListener("dblclick", (e) => {
  const el = e.target.closest(".s");
  if (!el) return;
  const x = (S.tl.subs || [])[Number(el.dataset.i)];
  if (!x || subIsAlg(x)) return toast("这段已经被算法剪掉了");
  S.subSel = Number(el.dataset.i);
  toggleSubCut();
});
$("subToggle").onclick = toggleSubCut;
$("subClose").onclick = () => { S.subSel = null; paintSubs(); paintSubBar(); };

// 细切之后一块只有十来像素，字放不下 —— 悬停立刻把「时间 + 全文」浮出来，
// 不用等浏览器原生 title 的一秒延迟，也不必先点一下才知道自己要删哪句
const subTip = document.createElement("div");
subTip.className = "subtip";
subTip.hidden = true;
document.body.appendChild(subTip);

$("subs").addEventListener("mousemove", (e) => {
  const el = e.target.closest(".s");
  const x = el && S.tl ? (S.tl.subs || [])[Number(el.dataset.i)] : null;
  if (!x) { subTip.hidden = true; return; }
  subTip.innerHTML = `<b>${fmt(x.s)}–${fmt(x.e)}</b>${esc(x.z)}`;
  subTip.hidden = false;
  const w = subTip.offsetWidth, h = subTip.offsetHeight;
  subTip.style.left = `${Math.min(e.clientX + 12, innerWidth - w - 10)}px`;
  subTip.style.top = `${Math.max(8, e.clientY - h - 12)}px`;
});
$("subs").addEventListener("mouseleave", () => { subTip.hidden = true; });
document.addEventListener("keydown", (e) => {
  if (S.subSel == null) return;
  const el = e.target || {};
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); toggleSubCut(); }
  else if (e.key === "Escape") { S.subSel = null; paintSubs(); paintSubBar(); }
});

// 波形（装饰，按宽度铺满）
function paintWave() {
  const w = $("wave");
  const n = Math.max(40, Math.floor(w.clientWidth / 4.2));
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  w.innerHTML = Array.from({ length: n }, (_, i) => {
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / 11));
    return `<b style="height:${(10 + rnd() * 30 * env).toFixed(1)}px"></b>`;
  }).join("");
}
window.addEventListener("resize", () => { if (S.tl) { paintWave(); paintRuler(); paintSubs(); } });

// ───────────────────────── 导出 ─────────────────────────
// 「更改」：网页拿不到本地绝对路径（<input webkitdirectory> 只给相对名），
// 所以让本机服务弹一个系统文件夹选择器，再把选中的路径写回 .env。
$("btnEdit").onclick = async () => {
  const b = $("btnEdit");
  if (b.disabled) return;
  b.disabled = true; b.textContent = "选择中…";
  try {
    const r = await postJSON("/api/pick-dir", { initial: (S.cfg && S.cfg.exportDir) || "" });
    if (!r || !r.ok) {
      if (r && r.canceled) toast("已取消，导出路径没变");
      else toast((r && r.error) || "打不开文件夹选择器", true);
      return;
    }
    await saveExportDir(r.dir);
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false; b.textContent = "更改";
  }
};

async function saveExportDir(dir) {
  if (S.cfg) S.cfg.exportDir = dir;      // 先本地生效，避免回读到旧值闪一下
  paintExportPath();
  const saved = await postJSON("/api/config", { exportDir: dir, name: S.name || "" });
  await loadConfig();
  paintExportPath();
  toast(saved && saved.copied
    ? `导出路径已改到 ${dir} · 当前成片已复制过去`
    : `导出路径已改到 ${dir}`);
}

$("btnReveal").onclick = () => revealOut("export");
$("btnRevealOut").onclick = () => revealOut("out");
async function revealOut(target) {
  if (!S.name) return toast("还没有成片", true);
  try {
    // 「打开文件夹」只开目录（成片交给右上角「打开成片」），
    // 「打开成片」打开正在预览的那一版，不是永远最新版
    const r = await postJSON("/api/reveal", { name: S.name, target, v: S.viewVer || 0 });
    if (r.mode === "dir" && target !== "export") toast("成片还没进导出目录，先打开了工程目录", true);
    else toast(target === "export" ? "已打开导出文件夹" : `已用默认播放器打开 v${S.viewVer || "?"}`);
  } catch (e) {
    // 打不开时别只说"失败"——顺手拉一次自检，把最可能的原因一起告诉用户
    toast(e.message, true);
    try {
      const d = await api("/api/diag");
      const p = [];
      if (d.exportDir && d.exportDir.fallback) p.push(`导出目录回退到 ${d.exportDir.dir}`);
      if (d.exportDir && d.exportDir.wantedDriveOk === false) p.push(`.env 里的盘符在本机不存在`);
      if (d.tools && d.tools.powershell && !d.tools.powershell.ok) p.push("PowerShell 不可用");
      if (d.tools && d.tools.ffmpeg && !d.tools.ffmpeg.ok) p.push("ffmpeg 不在 PATH");
      if (p.length) toast("自检：" + p.join("；"), true);
    } catch {}
  }
}

// ───────────────────────── 快捷键 ─────────────────────────
document.addEventListener("keydown", (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  if (!S.active) return;
  if (e.key === "d" || e.key === "D") { decide(S.active, "cut"); e.preventDefault(); }
  else if (e.key === "k" || e.key === "K") { decide(S.active, "keep"); e.preventDefault(); }
  else if (e.code === "Space") {
    const it = S.review.find((x) => x.id === S.active);
    if (it) { playRange(it.s - 1.5, it.e + 1.5); e.preventDefault(); }
  }
});

// ───────────────────────── 启动 ─────────────────────────
async function restore(name) {
  if (!name) return;
  S.name = name;
  const it = (S.projects || []).find((p) => p.name === name);
  $("fName").textContent = it ? it.title : prettyName(name);
  $("fileCard").hidden = false;
  try {
    const st = await api(`/api/state?name=${encodeURIComponent(name)}`);
    paintState(st);
    if (S.logOpen) await loadFullLogs();
    if (st.input) S.file = st.input;
    if (st.vertical != null && !st.outDur) $("fMeta").innerHTML = `<i class="tag">${st.vertical ? "竖屏" : "横屏"}</i>${(st.dur || 0).toFixed(1)}s`;
    if (st.outDur) $("fMeta").innerHTML = `<i class="tag">已裁剪</i>${st.outDur.toFixed(1)}s 成片${st.curVer ? ` · v${st.curVer}` : ""}`;
    if (st.running) { S.running = true; S.mode = st.mode || "cut"; pollStart(); return; }
    // 素材已上传但还没跑过 → 自动开始（没有「开始剪辑」按钮）。
    // 跑过却仍然 idle（没有 cut-plan）= 上次失败，只给「重试」，不在刷新时无限重跑。
    if (st.idle) {
      S.versions = []; S.curVer = 0; S.viewVer = 0;
      paintVersions();
      setStep("upload");
      ensurePreview();
      if (st.attempts > 0 || st.error) {
        setStatus(st.stage || "上次处理失败", "● 失败", "warn");
        $("btnRetry").hidden = false;
      } else {
        await autoStart();
      }
      return;
    }
    if (st.exitCode === 0 || st.done) {
      await loadTimeline();
      setSrc("out", true);
      setStatus(st.mode === "reexport" ? "重剪完成" : "待审核", "● 就绪", "ok");
    } else if (st.exitCode) {
      setStatus("失败", "● 失败", "warn");
      $("btnRetry").hidden = false;
    }
  } catch (e) { /* 没有这个任务就留在初始态 */ }
}

(async function boot() {
  paintWave();
  // 界面偏好：倍速与日志展开状态跨刷新保留
  setRate(Number(localStorage.getItem("studio.rate")) || 1, true);
  S.logOpen = localStorage.getItem("studio.logOpen") === "1";
  paintLogOpen();
  try { await loadConfig(); } catch (e) { toast("读配置失败：" + e.message, true); }
  await loadProjects();
  const q = new URLSearchParams(location.search).get("name");
  const saved = localStorage.getItem("studio.name");
  // 优先 URL 指定 → 其次上次打开的 → 最后取列表里最新的一条
  const pick = [q, saved].find((n) => n && S.projects.some((p) => p.name === n))
    || (S.projects[0] && S.projects[0].name);
  if (pick) await restore(pick);
})();
