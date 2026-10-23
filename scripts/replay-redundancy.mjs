// 诊断用：按 run.mjs 的完全相同口径重放 redundancy 裁决，把 verdicts 落盘。
// 用途：run.mjs 目前不保存 redundancy 裁决明细，复盘"某句为什么没被剪"时没有证据。
// 用法: node scripts/replay-redundancy.mjs <episode名>
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EP = process.argv[2];
if (!EP) { console.error("用法: node scripts/replay-redundancy.mjs <episode>"); process.exit(1); }
const ROOT = process.cwd();
const segs = JSON.parse(fs.readFileSync(path.join(ROOT, "episodes", EP, "work/raw-segs.json"), "utf8"));
const nrmT = (s) => String(s || "").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
const payload = {
  segments: segs.map((x, i) => ({ id: i, s: +x.s.toFixed(2), e: +x.e.toFixed(2), text: nrmT(x.z) })),
};
const tpl = fs.readFileSync(path.join(ROOT, "firstcut/arbiter-prompt-redundancy.md"), "utf8");
const prompt = tpl.replaceAll("{{INPUT}}", JSON.stringify(payload));
const r = spawnSync(process.execPath, [path.join(ROOT, "firstcut/llm.mjs")], {
  input: prompt, encoding: "utf8", maxBuffer: 64e6, timeout: 900000,
});
if (r.status !== 0) { console.error("llm failed", r.status, r.stderr?.slice(0, 500)); process.exit(1); }
const out = r.stdout || "";
let v;
try { v = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)); }
catch { console.error("parse failed:", out.slice(0, 800)); process.exit(1); }
const dst = path.join(ROOT, "episodes", EP, "work/redundancy-verdicts.json");
fs.writeFileSync(dst, JSON.stringify(v, null, 1), "utf8");
console.log("saved", dst, "verdicts:", v.verdicts?.length);
for (const it of v.verdicts || []) {
  const s = segs[it.id];
  if (!s) continue;
  const mark = it.label === "ok" ? "  " : "✂ ";
  console.log(`${mark}#${String(it.id).padStart(2)} [${String(it.label).padEnd(10)}] ${s.s.toFixed(1)}-${s.e.toFixed(1)} keep=${it.keepId ?? "-"} ${nrmT(s.z).slice(0, 34)}  | ${(it.reason || "").slice(0, 70)}`);
}
