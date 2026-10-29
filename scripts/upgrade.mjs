#!/usr/bin/env node
// 接管旧版数据 —— 只在免安装包里跑，源码仓库里是空操作。
//
// 背景：v1.0.x 的工程数据（episodes / uploads / .env）就在程序目录里，换一个新版本解压出来
// 就是一套全新的空数据，用户得手工搬。从 v1.1 起数据统一放在「数据目录」（见 firstcut/home.mjs），
// 程序目录变成可以随时替换的壳。新包第一次启动时由启动器调用本脚本：
//
//   1. 找旧版安装目录（新包同级、桌面、下载、各盘一层目录，认名字或认 studio/app.js + firstcut/run.mjs）
//   2. 停掉旧版还在跑的实例（读它的 .studio.pid，并核对命令行确实是 studio-server.mjs，避免误杀）
//   3. 把 episodes / uploads / exports / .env 搬进数据目录（同盘 rename，跨盘 robocopy 增量合并）
//   4. 旧版程序目录整个移进回收站（不是永久删除，能从回收站还原）
//   5. 结果写进 <数据目录>\.upgrade.json，界面启动后提示一次「已接管 N 个工程」
//
// 用法：node scripts/upgrade.mjs [--dry-run] [--keep-old]
//   --dry-run   只打印计划，不动任何文件
//   --keep-old  只搬数据，不回收旧目录
// 环境变量：XUNJIAN_HOME 指定数据目录；XUNJIAN_KEEP_OLD=1 同 --keep-old
//
// 安全边界：
//   · 只处理「同时有 studio/app.js 与 firstcut/run.mjs」的目录，别的一律不碰
//   · 带 .git 的目录直接跳过（那是源码工作区）
//   · 迁移失败只记日志，不删任何东西
//   · 已经在用程序目录当数据目录（源码仓库 / 老布局）时，直接退出
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeOf, HOME_DIRS, HOME_FILES } from "../firstcut/home.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HOME = homeOf(ROOT);
const DRY = process.argv.includes("--dry-run");
const KEEP_OLD = process.argv.includes("--keep-old") || process.env.XUNJIAN_KEEP_OLD === "1";
const LOG_FILE = path.join(HOME, "upgrade.log");
// 双击启动时 PATH 里有 System32，从 Git Bash / 精简环境启动时没有 —— 用绝对路径最稳
const PS = (() => {
  const abs = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(abs) ? abs : "powershell.exe";
})();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
}

// ── 判断一个目录是不是「本程序的免安装包」 ──
// 光有 studio/app.js + firstcut/run.mjs 不够：源码工作区也长这样，而源码工作区是绝不能碰的。
// 免安装包一定带 runtime\node\node.exe 或启动器 —— 用这个把「安装目录」和「开发目录」分开。
const isPkgDir = (dir) =>
  fs.existsSync(path.join(dir, "studio", "app.js"))
  && fs.existsSync(path.join(dir, "firstcut", "run.mjs"))
  && (fs.existsSync(path.join(dir, "runtime", "node", "node.exe"))
    || fs.existsSync(path.join(dir, "启动 AI初剪工作台.cmd")));

// 免安装包里允许出现的顶层项；出现别的东西说明这目录里还放着用户的其它文件，不能整体回收
const PKG_ITEMS = new Set([
  "studio", "firstcut", "scripts", "runtime", "licenses", "assets", "node_modules",
  "episodes", "uploads", "exports", "tmp", "package.json", "package-lock.json",
  "readme.md", "license", ".env", ".env.example", ".gitignore", ".studio.pid",
  "使用说明.txt", "启动 ai初剪工作台.cmd", "停止 ai初剪工作台.cmd",
]);

function safeToRetire(dir) {
  if (!isPkgDir(dir)) return false;
  if (fs.existsSync(path.join(dir, ".git"))) return false;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return false; }
  const unknown = names.filter((n) => !PKG_ITEMS.has(n.toLowerCase()));
  if (unknown.length) {
    log(`旧目录里有不属于程序本身的内容（${unknown.slice(0, 4).join("、")}${unknown.length > 4 ? " 等" : ""}），整体保留，不回收`);
    return false;
  }
  return true;
}

function projectCount(dir = path.join(HOME, "episodes")) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "demo").length;
  } catch {
    return 0;
  }
}

// 旧版目录里还有没有「用户数据」——有就不能删（空目录不算，服务端会自动建）
function hasUserData(dir) {
  for (const d of HOME_DIRS) {
    try { if (fs.readdirSync(path.join(dir, d)).length) return true; } catch {}
  }
  return HOME_FILES.some((f) => fs.existsSync(path.join(dir, f)));
}

// ── 找旧版：新包同级 + 桌面/下载/文档 + 各盘一层目录 ──
const SKIP = new Set([
  "node_modules", ".git", "$recycle.bin", "system volume information", "windows", "windowsapps",
  "program files", "program files (x86)", "programdata", "appdata", "runtime", "firstcut", "studio",
  "scripts", "episodes", "uploads", "exports", "tmp", "temp", "recovery", "perflogs", "msocache",
]);

function* walkDirs(start, maxDepth) {
  const t0 = Date.now();
  let seen = 0;
  const stack = [[start, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (++seen > 4000 || Date.now() - t0 > 4000) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (SKIP.has(e.name.toLowerCase())) continue;
      const full = path.join(dir, e.name);
      yield full;
      if (depth + 1 < maxDepth) stack.push([full, depth + 1]);
    }
  }
}

function searchRoots() {
  const user = process.env.USERPROFILE || os.homedir();
  const roots = [
    path.dirname(ROOT),
    path.join(user, "Desktop"),
    path.join(user, "Downloads"),
    path.join(user, "Documents"),
    path.join(user, "OneDrive", "Desktop"),
    path.join(user, "OneDrive", "Downloads"),
  ];
  for (const d of "CDEFGH") {
    const r = `${d}:\\`;
    try { if (fs.existsSync(r)) roots.push(r); } catch {}
  }
  return roots.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

function findLegacy() {
  const out = new Map();
  const add = (dir) => {
    const abs = path.resolve(dir);
    if (out.has(abs.toLowerCase())) return;
    if (abs.toLowerCase() === ROOT.toLowerCase()) return;
    if (abs.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep)) return; // 新包自己内部
    if (!isPkgDir(abs)) return;
    if (fs.existsSync(path.join(abs, ".git"))) return;                     // 源码工作区，别碰
    if (!hasUserData(abs)) return;
    out.set(abs.toLowerCase(), abs);
  };
  for (const r of searchRoots()) {
    add(r);
    for (const d of walkDirs(r, 2)) add(d);
  }
  // 版本号大的、最近写过的排前面：.env 这类「只补缺失」的数据要优先来自最新那份
  const score = (dir) => {
    const m = /-(\d+\.\d+\.\d+)-win-x64/i.exec(path.basename(dir));
    let t = 0;
    try { t = fs.statSync(path.join(dir, "episodes")).mtimeMs; } catch {}
    return [m ? Number(m[1].split(".").map((x, i) => Number(x) * [10000, 100, 1][i]).reduce((a, b) => a + b, 0)) : 0, t];
  };
  return [...out.values()].sort((a, b) => {
    const [va, ta] = score(a), [vb, tb] = score(b);
    return vb - va || tb - ta;
  });
}

// ── 停掉旧实例：先核对命令行，别拿一个复用的 PID 去杀无关进程 ──
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cmdlineOf(pid) {
  if (process.platform !== "win32") {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; }
  }
  const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`;
  const r = spawnSync(PS, ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 15000 });
  return String(r.stdout || "").trim();
}

function stopInstance(dir) {
  const pf = path.join(dir, ".studio.pid");
  if (!fs.existsSync(pf)) return false;
  const pid = Number(String(fs.readFileSync(pf, "utf8")).trim());
  if (!pid || !alive(pid)) return false;
  const cmd = cmdlineOf(pid);
  // 只杀「跑着本目录下 studio-server.mjs 的 node」；核对不出来就不动
  const norm = (s) => s.replace(/\\/g, "/").toLowerCase();
  if (!cmd || !norm(cmd).includes("studio-server.mjs")) {
    log(`旧实例 PID ${pid} 无法确认是本程序（命令行：${cmd || "空"}），不杀，继续搬迁`);
    return false;
  }
  if (!norm(cmd).includes(norm(dir))) {
    log(`旧实例 PID ${pid} 不是 ${dir} 里那个，跳过`);
    return false;
  }
  try { process.kill(pid); log(`已停止旧实例 PID ${pid}（${dir}）`); } catch (e) { log(`停止旧实例失败：${e.message}`); return false; }
  for (let i = 0; i < 60 && alive(pid); i++) sleep(100);
  return !alive(pid);
}

// ── 搬运：同盘 rename（瞬间完成），跨盘/目标已存在时增量合并 ──
function mergeCopy(src, dst) {
  if (process.platform === "win32") {
    // robocopy 的 0~7 都算成功；/XC /XN /XO = 已存在的文件一律不覆盖
    const r = spawnSync("robocopy", [src, dst, "/E", "/XC", "/XN", "/XO", "/R:2", "/W:2", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { windowsHide: true });
    if (r.status === null || r.status >= 8) {
      log(`robocopy 失败（${r.status}）：${src} -> ${dst}`);
      return false;
    }
  } else {
    const r = spawnSync("cp", ["-rn", src + "/.", dst], { windowsHide: true });
    if (r.status !== 0) return false;
  }
  try { fs.rmSync(src, { recursive: true, force: true }); } catch (e) { log(`清理源目录失败：${e.message}`); }
  return true;
}

function moveDir(src, dst) {
  if (DRY) { log(`[计划] ${src}  →  ${dst}`); return true; }
  if (!fs.existsSync(dst)) {
    try { fs.renameSync(src, dst); log(`已搬移 ${path.basename(src)}（同盘直接改名）`); return true; }
    catch (e) { if (e.code !== "EXDEV") { log(`搬移失败 ${src}：${e.message}`); return false; } }
    log(`${path.basename(src)} 跨盘，改为复制（大文件会慢，请等它跑完）`);
  } else {
    log(`数据目录里已有 ${path.basename(src)}，改为增量合并（同名工程保留原样）`);
  }
  const ok = mergeCopy(src, dst);
  if (ok) log(`已合并 ${path.basename(src)}`);
  return ok;
}

function adopt(dir) {
  const done = [];
  const before = projectCount();
  for (const d of HOME_DIRS) {
    const src = path.join(dir, d);
    if (!fs.existsSync(src)) continue;
    let names = [];
    try { names = fs.readdirSync(src); } catch {}
    if (!names.length) { log(`跳过空的 ${d}/`); continue; }
    if (moveDir(src, path.join(HOME, d))) done.push(d);
  }
  for (const f of HOME_FILES) {
    const src = path.join(dir, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(HOME, f);
    if (!fs.existsSync(dst)) {
      if (DRY) { log(`[计划] 接管设置文件 ${f}`); done.push(f); continue; }
      try { fs.copyFileSync(src, dst); fs.unlinkSync(src); } catch (e) { log(`复制 ${f} 失败：${e.message}`); continue; }
      log(`已接管设置文件 ${f}`);
      done.push(f);
    } else {
      // 两边都有：内容一样就把旧的删掉；不一样则把旧的另存一份再删，
      // 既不覆盖现有设置，也不至于让旧目录因为一个 .env 而永远删不掉
      const same = (() => { try { return fs.readFileSync(src).equals(fs.readFileSync(dst)); } catch { return false; } })();
      if (DRY) { log(`[计划] 处理重复的 ${f}（${same ? "内容相同" : "内容不同，另存后删"}）`); continue; }
      try {
        if (same) fs.unlinkSync(src);
        else {
          const bak = path.join(HOME, `${f}.from-old-${Date.now()}`);
          fs.copyFileSync(src, bak); fs.unlinkSync(src);
          log(`旧版 ${f} 与现有设置不同，已另存为 ${path.basename(bak)}`);
        }
      } catch {}
    }
  }
  return { done, added: projectCount() - before };
}

// ── 旧版程序目录移入回收站（可还原） ──
function recycle(dir) {
  if (DRY) { log(`[计划] 旧版目录移入回收站：${dir}`); return true; }
  if (process.platform !== "win32") return false;
  const esc = dir.replace(/'/g, "''");
  const ps = "Add-Type -AssemblyName Microsoft.VisualBasic; "
    + `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${esc}','OnlyErrorDialogs','SendToRecycleBin')`;
  const r = spawnSync(PS, ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 180000 });
  if (r.status !== 0) {
    const err = String(r.stderr || r.error?.message || "").trim().split(/\r?\n/)[0];
    log(`回收站命令失败（${r.status ?? "无法启动"}）：${err || "未知原因"}`);
  }
  return r.status === 0;
}

// ── 主流程 ──
function main() {
  if (path.resolve(HOME).toLowerCase() === path.resolve(ROOT).toLowerCase()) return; // 源码仓库 / 老布局，无需接管

  // 注意：这里不能预先建 episodes/uploads，否则旧版的目录就没法「同盘改名」搬进来，
  // 只能退化成整盘复制。空目录等搬完再补（见 finally）。

  // 已经有工程就不用再扫盘：接管只在「数据目录还是空的」时候有意义，
  // 否则每次启动都要把几个盘扫一遍（1~2 秒），而且用户也可能拿旧目录当归档。
  if (projectCount() > 0) return;

  const lock = path.join(HOME, ".upgrade.lock");
  if (!DRY) {
    try {
      const pid = Number(fs.readFileSync(lock, "utf8").trim());
      if (pid && pid !== process.pid && alive(pid)) return; // 另一个实例正在搬
    } catch {}
    try { fs.writeFileSync(lock, String(process.pid)); } catch {}
  }

  try {
    const legacy = findLegacy();
    if (!legacy.length) {
      if (DRY) log("[计划] 没有发现旧版安装目录");
      return;
    }
    log(`发现 ${legacy.length} 个可能是旧版的目录：`);
    for (const d of legacy) log(`  · ${d}（${projectCount(path.join(d, "episodes"))} 个工程）`);

    const adoptedFrom = [];
    const retired = [];
    for (const dir of legacy) {
      log(`处理 ${dir}`);
      stopInstance(dir);
      const { added } = adopt(dir);
      adoptedFrom.push(dir);
      log(DRY ? `接管计划已生成：${dir}` : `接管 ${dir} 完成，新增 ${added} 个工程`);

      if (hasUserData(dir)) { log(`旧目录里还留有数据，保留不删：${dir}`); continue; }
      if (KEEP_OLD) { log(`按参数保留旧目录：${dir}`); continue; }
      if (!safeToRetire(dir)) continue;
      if (recycle(dir)) { retired.push(dir); log(`旧版程序目录已移入回收站：${dir}`); }
      else log(`移入回收站失败，旧目录保留：${dir}`);
    }

    if (!DRY && (adoptedFrom.length || retired.length)) {
      const summary = {
        at: new Date().toISOString(),
        version: pkgVersion(),
        home: HOME,
        from: adoptedFrom,
        retired,
        projects: projectCount(),
      };
      try { fs.writeFileSync(path.join(HOME, ".upgrade.json"), JSON.stringify(summary, null, 2)); } catch {}
      try { fs.writeFileSync(path.join(HOME, ".scan.json"), JSON.stringify({ at: Date.now(), found: legacy.length })); } catch {}
      log(`接管完成：数据目录 ${HOME}，现有 ${summary.projects} 个工程`);
    }
  } finally {
    if (!DRY) {
      try { fs.unlinkSync(lock); } catch {}
      // 搬完之后保证数据目录的骨架在（服务端也会建，这里建好省得首屏报错）
      try {
        fs.mkdirSync(path.join(HOME, "episodes"), { recursive: true });
        fs.mkdirSync(path.join(HOME, "uploads"), { recursive: true });
      } catch {}
    }
  }
}

try {
  main();
} catch (e) {
  log(`接管旧版数据出错（已忽略，程序继续启动）：${e && e.message ? e.message : e}`);
}
