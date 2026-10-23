// 重说口误检测 —— 找出"说错→停顿→重说"里作废的前一遍，交给剪切列表剪掉
// 判定原则(保守优先,宁漏勿误剪):
//   ① 只比较时间上紧挨着的句子(间隔≤maxGapSec、往后最多看 lookAheadSegs 句)——隔很远的相似句多半是刻意呼应,不动
//   ② 两种命中: 整句高相似(说错个别词重说) / 前句是后句的开头(半句卡壳重来)
//   ③ 命中永远剪"前一遍"保"后一遍"——重说的那遍才是想要的
// 纯算法零依赖,--no-ai 模式同样可用
// 阈值全部来自 opts(由 run.mjs 从 firstcut/rules.json 注入);未传时回落到本文件默认值(与 rules.json 出厂值一致)

const norm = (z) => String(z || "").replace(/[\s，。、？！；：""''…—·,.?!;:'"()（）﹙﹚]/g, "");

// 标点/空白集合(供语气词候选的字级切分用)
const PUNCT_RE_JS = /[\s，。、？！；：""''…—·,.?!;:'"()（）﹙﹚]/g;

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const simRatio = (a, b) => { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 0; };
// 最长公共前缀长度。重说场景的"前一遍被打断 → 重说"往往只有句尾几个字不同，
// 相似度(整句 Levenshtein)会被尾部差异拉低而被漏检，LCP 则对"开头完全一致"极其敏感：
// 实测真重说 LCP=10，而其余 28 对相邻句段 LCP≤2，判别余量极大。
const lcp = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i; };

/**
 * @param segments  whisper 原始句段 [{s,e,z}] (原片时间轴,未拆行)
 * @param opts      { sim, maxGapSec, minChars, lookAheadSegs, prefixSimMin, breatheSec, minCutSec, mergeGapSec }
 * @returns { cuts: [[s,e],...] 待剪区间(已合并), report: [{s,e,cut,kept}] 剪除清单 }
 */
/**
 * 换说法重说护栏（确定性）——若「保留文本」是「剪除文本」的**真后缀**
 * （实测 C0779：剪「我覺得孩子成績不好」/ 留「孩子成績不好」），说明前一遍才更完整、
 * 后一遍只是截断重述（换了个开头的说法），剪掉会把前半句信息一起删掉 → 一律不剪。
 * @returns true = 该候选"安全可剪"，false = 命中护栏，应保留。
 */
export const retakeSuffixOk = (r) => {
  const a = norm(r && r.cut), b = norm(r && r.kept);
  return !(b && a && b.length < a.length && a.endsWith(b));
};

export function detectRetakes(segments, opts = {}) {
  const SIM = opts.sim ?? 0.8, GAP = opts.maxGapSec ?? 8, MIN = opts.minChars ?? 5;
  const LOOK = opts.lookAheadSegs ?? 3, PREFIX = opts.prefixSimMin ?? 0.85;
  const BREATHE = opts.breatheSec ?? 0.05, MINCUT = opts.minCutSec ?? 0.3;
  const MERGEGAP = opts.mergeGapSec ?? 0.1;
  // LCP 判据：开头连续一致 ≥ lcpMin 字、且间隔 ≤ lcpGapSec 秒 → 判为重说。
  // 这是对"整句相似度/前缀相似度"两条判据的补充——它不要求后句更长，也不受句尾差异影响。
  const LCPMIN = opts.lcpMin ?? 6, LCPGAP = opts.lcpGapSec ?? 2.0;
  // 近乎逐字重复(整句相似度 ≥ dupSim、间隔 ≤ dupGapSec)也属确定性命中：
  // 实测三素材全部 full≥0.85 的近邻对都是真重说（无一误报）；这类"剪/留文本几乎一样"的候选
  // 交 LLM 反而容易被否掉（它看到两段一模一样，会当成刻意的排比/强调），故直接采纳。
  const DUPSIM = opts.dupSim ?? 0.9, DUPGAP = opts.dupGapSec ?? 20;
  const segs = (segments || []).filter((x) => x && x.z != null && x.e > x.s);
  const removed = new Set(), keptSet = new Set(), report = [];
  const cmp = (x, y) => { for (let k = 0; k < x.length; k++) { if (x[k] > y[k]) return 1; if (x[k] < y[k]) return -1; } return 0; };
  for (let i = 0; i < segs.length; i++) {
    if (removed.has(i) || keptSet.has(i)) continue;
    const ni = norm(segs[i].z);
    if (ni.length < MIN) continue;
    // 在窗口内取「最像的那一个」而不是「第一个合格的」——
    // 放宽召回阈值后，紧邻的下一句常会以微弱相似度假配上（实测 C0777「孩子的专注|孩子的底气|…|孩子的专注|孩子的底气」：
    // i+1 以 0.6 抢先匹配，把真正的 i+3「专注→专注」(1.0) 遮蔽，导致重说漏检）。
    let bestJ = -1, bestKey = null, bestInfo = null;
    for (let j = i + 1; j <= Math.min(i + LOOK, segs.length - 1); j++) {
      if (removed.has(j) || keptSet.has(j)) continue;
      if (segs[j].s - segs[i].e > GAP) break;
      const nj = norm(segs[j].z);
      if (nj.length < MIN) continue;
      const full = simRatio(ni, nj);                       // 整句高相似
      const prefix = nj.length >= ni.length ? simRatio(ni, nj.slice(0, ni.length)) : 0;  // 半句卡壳重来
      const gap = segs[j].s - segs[i].e;
      const lp = lcp(ni, nj);                              // 最长公共前缀
      const isLcp = lp >= LCPMIN && gap <= LCPGAP;
      const isDup = full >= DUPSIM && gap <= DUPGAP;       // 近乎逐字重复
      const strong = full >= SIM || prefix >= Math.max(SIM, PREFIX);
      if (!strong && !isLcp && !isDup) continue;
      // 评分：先比相似度，再比公共前缀长度，最后取更近的（距离小者优先）
      const key = [Math.max(full, prefix), lp, -(j - i)];
      if (bestKey === null || cmp(key, bestKey) > 0) {
        bestKey = key; bestJ = j;
        bestInfo = { full, prefix, gap, lp, isLcp, isDup,
                     kind: isLcp ? "lcp" : (isDup ? "dup" : (full >= SIM ? "full" : "prefix")) };
      }
    }
    if (bestJ >= 0) {
      removed.add(i);
      keptSet.add(bestJ);   // 已定为"要保留的那遍"，不再作为别的重说的待剪段（避免「保留段」又被判废）
      report.push({
        s: segs[i].s, e: segs[i].e, cut: segs[i].z.trim(), kept: segs[bestJ].z.trim(),
        sim: +Math.max(bestInfo.full, bestInfo.prefix).toFixed(3), lcp: bestInfo.lp,
        gap: +bestInfo.gap.toFixed(2), kind: bestInfo.kind,
      });
    }
  }
  // 换说法护栏：先剔除「保留是剪除的后缀」的候选（前一遍更完整），再汇剪切区间。
  const _keptReport = report.filter(retakeSuffixOk);
  const guardDropped = report.length - _keptReport.length;
  report.length = 0; report.push(..._keptReport);
  // 汇成剪切区间:边缘各留 breatheSec 呼吸,太碎的(<minCutSec)不值得动刀
  let cuts = report
    .map((r) => [Math.max(0, r.s - BREATHE), r.e + BREATHE])
    .filter(([s, e]) => e - s >= MINCUT)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1] + MERGEGAP) last[1] = Math.max(last[1], c[1]);
    else merged.push(c);
  }
  return { cuts: merged, report, guardDropped };
}

/**
 * 段内"卡壳重说"检测 —— whisper 常把"半句卡壳 → 重说"合并成一句话，并把停顿
 * 吸收进其中某个词的时长里（实测单字「别」占 2.06s，是正常单字的 10 倍以上）。
 * 此时文本层根本没有重复，段间相似度比对必然漏检。
 *
 * 改用两个信号联合判定：
 *   ① 段语速异常低（字/秒 < cps）—— 文本那么少却占了那么长时间，说明里面有冗余
 *   ② 段内存在异常长词（单字时长 > word 秒）
 * 命中则以"异常长词的起点"为切分点，剪掉它之前的部分（卡壳的前半遍），保留后半遍。
 *
 * @param segments 含词级时间戳的句段 [{s,e,z,w:[[s,e,word],...]}]
 * @param opts { word: 异常长词阈值秒(默认1.0), cps: 异常低语速阈值(默认3.5),
 *               minSeg: 段最短时长(默认1.5), minChars: 段最少字数(默认4), minCutSec: 最小切长(默认0.5) }
 */
export function detectStutters(segments, opts = {}) {
  // ── 云端模式（paraformer-v2 文件转写）──────────────────────────────────
  // 上面那套判据的两个前提在云端**同时失效**：
  //   ① whisper 把停顿吸收进词时长（卡壳处单字可达 2.06s）→ 云端是真实对齐，
  //      实测 c1 全片 376 个字：p50=0.16s、p95=0.36s、max=0.73s，**无一字超过 0.8s**；
  //   ② whisper 的句段含停顿（卡壳段 cps 2.80 是离群值）→ 云端句段只算说话时长，
  //      实测卡壳段 5.34 与正常段 4.58~6.44 完全重叠，**cps 零区分度**。
  // 故云端改用文本证据：段内「前半被打断 → 同一开头重来」= 假起头（inner retake）。
  // 这与 DUP_HEAD 的段间版本互补：DUP_HEAD 管跨句段，这里管同一句段内部。
  if ((opts.mode ?? "long-word") === "inner-retake") return detectInnerRetakes(segments, opts);

  // 阈值标定依据(实测该素材)：正常口播段语速集中在 4.0~6.4 字/秒，
  // 含卡壳重说的那段仅 2.80 字/秒，是明显的离群值 → cps 取 3.5 留足余量。
  const WORD = opts.word ?? 1.0, CPS = opts.cps ?? 3.5;
  const MINSEG = opts.minSeg ?? 1.5, MINCHARS = opts.minChars ?? 4;
  const MINCUT = opts.minCutSec ?? 0.5;
  const cuts = [], report = [];
  for (const sg of segments || []) {
    if (!sg || !Array.isArray(sg.w) || !sg.w.length) continue;
    const dur = sg.e - sg.s;
    const chars = norm(sg.z).length;
    if (dur < MINSEG || chars < MINCHARS) continue;      // 太短，判不准
    const cps = chars / dur;
    if (cps >= CPS) continue;                            // 语速正常 → 无可卡壳
    let li = -1;
    for (let k = 0; k < sg.w.length; k++) {
      const [ws, we] = sg.w[k];
      if (we - ws > WORD) { li = k; break; }
    }
    if (li <= 0) continue;                               // 无异常长词，或它就在段首
    const s0 = sg.w[0][0], cutE = sg.w[li][0];
    if (cutE - s0 < MINCUT) continue;                    // 前半太短，不值得动刀
    cuts.push([s0, cutE]);
    report.push({
      s: s0, e: cutE, cut: sg.z.trim(),
      kept: "（卡壳重说的后半遍）",
      reason: `语速仅 ${cps.toFixed(1)} 字/秒、单字最长 ${(sg.w[li][1] - sg.w[li][0]).toFixed(2)}s`,
    });
  }
  return { cuts, report };
}

/**
 * 段内「假起头」检测 —— 云端转写专用（paraformer-v2 字级真实时间戳）。
 *
 * 场景：说话人起了个头、词组还没说完就自己打断，紧接着用同一个开头重说，而
 * **这两遍被 ASR 塞进了同一个句段**（云端 VAD 按长停顿切段，这种"快速自我纠正"
 * 的间隙只有 0.09s，不会被切开）。
 *   实测 c1 开头：「我觉得家长在‖我觉得家长或者孩子在选择一个老师的时候」
 *   —— 前 6 字作废，`detectRetakes` 的段间比对看不到（它们在段内）。
 *
 * 判据（保守，只认"从段首开始的重来"）：
 *   ① 段首 j 字后，与段首连续重合 ≥ minRepeatChars 字；
 *   ② j 落在 2..maxHeadChars 字之间（重来点必须在开头附近，不是中途类比）；
 *   ③ 要删的部分 ≥ minCutSec 秒且 ≤ maxCutSec 秒（太长说明不是假起头，是别的东西）；
 *   ④ 重来版剩余 ≥ tailMinChars 字（保证删完还剩一句完整的话）。
 * 命中则删 [段首, 重来点)，保留重来版 —— 与"口误只保留最终一遍"的原则一致。
 *
 * @param segments 含字级时间戳的句段 [{s,e,z,w:[[s,e,word],...]}]
 * @param opts { minRepeatChars, maxHeadChars, minChars, minCutSec, maxCutSec, tailMinChars }
 */
export function detectInnerRetakes(segments, opts = {}) {
  const MINREP = opts.minRepeatChars ?? 5;
  const MAXHEAD = opts.maxHeadChars ?? 12;
  const MINCHARS = opts.minChars ?? 14;
  const MINCUT = opts.minCutSec ?? 0.25;
  const MAXCUT = opts.maxCutSec ?? 3.0;
  const TAILMIN = opts.tailMinChars ?? 8;
  // 第二类（段首引导语被打断）的阈值：与第一类不同，两遍文本**不重合**，全靠停顿与词性位置判定，
  // 所以护栏必须更硬，宁可漏。
  const LEADMAX = opts.leadMaxChars ?? 6;      // 前半最多 6 字（只说了一个引导语）
  const LEADGAP = opts.leadPauseSec ?? 0.30;   // 自我打断的停顿
  const LEADMIN = opts.leadMinCutSec ?? 0.30;
  const LEADMAXCUT = opts.leadMaxCutSec ?? 2.5;
  const LEADEND = /(我觉得|我想|我认为|我看|我感觉|就是说|就是|然后|那么|所以|因为|但是)$/;
  const LEADRESTART = /^(第[一二三四五六七八九十]|最后|首先|其次|然后|就是|那么|所以|因为|但是|不过|而且)/;
  const cuts = [], report = [];
  for (const sg of segments || []) {
    if (!sg || !Array.isArray(sg.w) || !sg.w.length) continue;
    // 展平成字序列（云端时间戳是字级；数字/英文串会是多字一个 token，按字均摊）
    const chars = [];
    for (const [ws, we, word] of sg.w) {
      const clean = String(word || "").replace(PUNCT_RE_JS, "");
      const n = Math.max(1, clean.length);
      let k = 0;
      for (const ch of clean) {
        const a = ws + (we - ws) * (k / n), b = ws + (we - ws) * ((k + 1) / n);
        chars.push([ch, a, b]);
        k++;
      }
    }
    const text = chars.map((c) => c[0]).join("");
    if (text.length < MINCHARS) continue;
    // ── 第一类：段首假起头（两遍文本重合）──
    // 在段首附近找「重来点」：取重合最长的那一个
    let best = null;
    for (let j = 2; j <= Math.min(MAXHEAD, text.length - TAILMIN); j++) {
      let l = 0;
      while (l < j && j + l < text.length && text[l] === text[j + l]) l++;
      if (l >= MINREP && (!best || l > best.l)) best = { j, l };
    }
    if (best) {
      const s0 = chars[0][1], cutE = chars[best.j][1];
      const dur = cutE - s0;
      if (dur >= MINCUT && dur <= MAXCUT) {
        cuts.push([s0, cutE]);
        report.push({
          s: s0, e: cutE, cut: text.slice(0, best.j),
          kept: text.slice(best.j, best.j + 16),
          reason: `段内假起头：前 ${best.j} 字被打断后重说（与重来版重合 ${best.l} 字）`,
        });
        continue;   // 同一句段只做一处切口
      }
    }
    // ── 第二类：段首引导语被打断 → 枚举/承接词重起 ──
    // 实测 c3 #9：「第三点我觉得」69.13–70.07（0.94s）→ 停顿 0.47s →
    //              「最后一点，我觉得习惯也特别的重要」70.54–72.80。
    // 「第三点我觉得」是个没说完的引导语（"我觉得"后面本该接内容，却自己断了），
    // 随后用"最后一点"重新起头 —— 前半是废起头，但两遍**没有任何重合字**，
    // 第一类判据（重合 ≥5 字）与 DUP_HEAD（段首重合）都抓不到。
    // 四条硬护栏：① 前半 ≤6 字且以"我觉得/我想/…"结尾（自断信号）；
    //             ② 停顿 ≥0.30s（自我打断，不是句中换气）；
    //             ③ 后半 ≥8 字且以枚举/承接词开头（真的重新起头了）；
    //             ④ 只删到后半第一个字之前，**绝不整句删** —— 后半是论点话题句，删了就丢了论点。
    if ((opts.leadRestart ?? true) && text.length >= MINCHARS) {
      for (let k = 0; k < chars.length - 1; k++) {
        const gap = chars[k + 1][1] - chars[k][2];
        if (gap < LEADGAP) continue;
        const head = chars.slice(0, k + 1).map((c) => c[0]).join("");
        const rest = chars.slice(k + 1).map((c) => c[0]).join("");
        const dur = chars[k + 1][1] - chars[0][1];
        if (head.length >= 2 && head.length <= LEADMAX && LEADEND.test(head) &&
            rest.length >= 8 && LEADRESTART.test(rest) &&
            dur >= LEADMIN && dur <= LEADMAXCUT) {
          cuts.push([chars[0][1], chars[k + 1][1]]);
          report.push({
            s: chars[0][1], e: chars[k + 1][1], cut: head,
            kept: rest.slice(0, 16),
            reason: `段首引导语被打断：删「${head}」+ ${gap.toFixed(2)}s 停顿，保留重起的「${rest.slice(0, 10)}…」`,
          });
        }
        break;   // 只看**首个**停顿：后面的停顿不构成"段首起头失败"
      }
    }
    // ── 第三类：插词式假起头（重来版比第一遍多了一个修饰词）──
    // 实测 c3：「我 在现场带」69.59-71.09 ‖停顿 0.72s‖ 「我 在直播间现场带你来感受一下高效记的魔力」
    // 第一类要求两遍**连续**重合 ≥5 字，这里第二遍插进了"直播间"，只重合「我在」2 字 → 抓不到；
    // 第二类要求段首是"我觉得/然后"这类引导语，"我在现场带"也不适用。
    // 四条叠加（宁可漏，不新增误剪）：
    //   ① 重来点落在段首 3~6 字之后（前半是一小截废起头）；
    //   ② 该处停顿 ≥0.55s（自我打断；正常字间停顿实测 <0.30s）；
    //   ③ 重来点前 2 字与段首前 2 字相同 —— 证明是"同一句话重说"而不是另起一句；
    //   ④ 前半 ≤2.5s、重来版剩余 ≥10 字（删完还剩一句完整的话）。
    {
      const ILJMIN = 3, ILJMAX = 6, ILPAUSE = 0.55, ILHEAD = 2, ILMAXCUT = 2.5, ILTAIL = 10;
      if (text.length >= ILTAIL + ILJMIN) {
        for (let j = ILJMIN; j <= Math.min(ILJMAX, text.length - ILTAIL); j++) {
          const gap = chars[j][1] - chars[j - 1][2];
          if (gap < ILPAUSE) continue;
          if (text.slice(0, ILHEAD) !== text.slice(j, j + ILHEAD)) continue;
          const s0 = chars[0][1], cutE = chars[j][1];
          const dur = cutE - s0;
          if (dur < MINCUT || dur > ILMAXCUT) continue;
          cuts.push([s0, cutE]);
          report.push({
            s: s0, e: cutE, cut: text.slice(0, j),
            kept: text.slice(j, j + 16),
            reason: `插词式假起头：前 ${j} 字后停顿 ${gap.toFixed(2)}s，重来版以「${text.slice(j, j + ILHEAD)}」重新起头`,
          });
          break;
        }
      }
    }
  }
  return { cuts, report };
}

/** 从保留区间列表里挖掉待剪区间: subtractRanges([[0,60]], [[10,12]]) → [[0,10],[12,60]] */
export function subtractRanges(keep, cuts, minRemain = 0.2) {
  let out = keep.map((x) => [...x]);
  for (const [cs, ce] of cuts) {
    const next = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    out = next;
  }
  return out.filter(([s, e]) => e - s >= minRemain);
}

/**
 * 语气词(填充词)检测 —— 纯算法,零 LLM。
 * 只剪 tier1「纯语气词」(嗯/呃/哎/哎呀…):它们在任何语境下都不承载语义,剪掉不伤句意。
 * 判定条件(保守,宁漏勿误剪):
 *   ① 该词是 tier1 之一,且落在**词边界**上(不切词);
 *   ② **它前面有停顿**(≥standalonePauseSec)——针对"…停顿…嗯…"的犹豫起头;
 *      (句末的"好啊""对呀"是语气助词不是填充词,它们前面没停顿,故不会被误剪)
 *   ③ 时长 ≤ maxDurSec(真语气词很短,超时长的多半是有意义的长叹词)。
 * tier2(这个/那个/就是…)同形异用,须 LLM 判上下文,本轮不剪。
 *
 * @param segments 含词级时间戳的句段 [{s,e,z,w:[[s,e,word],...]}]
 * @param opts { tier1, standalonePauseSec, maxDurSec, minCutSec }
 */
export function detectFillers(segments, opts = {}) {
  const TIER1 = new Set(opts.tier1 ?? ["嗯", "呃", "啊", "唉", "哎", "哎呀", "哦", "噢"]);
  const PAUSE = opts.standalonePauseSec ?? 0.12;
  const MAXDUR = opts.maxDurSec ?? 0.6;
  const MINCUT = opts.minCutSec ?? 0.15;
  const cuts = [], report = [];
  const maxLen = Math.max(1, ...[...TIER1].map((w) => w.length));
  for (const sg of segments || []) {
    if (!sg || !Array.isArray(sg.w) || !sg.w.length) continue;
    // 展平成"字"序列(每字带所属词的时间),再在字串上找 tier1
    const chars = [];
    for (const [ws, we, word] of sg.w) {
      const clean = String(word || "").replace(PUNCT_RE_JS, "");
      for (const ch of clean) chars.push([ch, ws, we]);
    }
    if (!chars.length) continue;
    // 词边界(仅在词首/词尾处才允许切,避免切词)
    const bounds = new Set([0]);
    { let k = 0; for (const [, , word] of sg.w) { k += String(word || "").replace(PUNCT_RE_JS, "").length; bounds.add(k); } }
    const text = chars.map((c) => c[0]).join("");
    for (let i = 0; i < chars.length; i++) {
      for (let L = maxLen; L >= 1; L--) {
        if (i + L > chars.length) continue;
        const frag = text.slice(i, i + L);
        if (!TIER1.has(frag)) continue;
        if (!bounds.has(i) || !bounds.has(i + L)) continue;      // 必须整词对齐
        const st = chars[i][1], en = chars[i + L - 1][2];
        if (en - st > MAXDUR) continue;                          // 太长,多半不是语气词
        const prevEnd = i > 0 ? chars[i - 1][2] : null;
        const pauseBefore = prevEnd == null ? 99 : st - prevEnd; // 段首视为有停顿
        if (pauseBefore < PAUSE) continue;                       // 要求"前面有停顿"(排除句末助词)
        if (en - st < MINCUT) continue;
        cuts.push([st, en]);
        report.push({ s: st, e: en, cut: frag, kept: "（语气词，删除）", reason: "tier1 语气词" });
        break;
      }
    }
  }
  // 合并相邻(同一语气词被逐字命中时)
  cuts.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1] + 0.05) last[1] = Math.max(last[1], c[1]);
    else merged.push([...c]);
  }
  return { cuts: merged, report };
}

/**
 * tier2「同形异用」语气词候选查找 —— 只出候选,是否剪交 LLM 判上下文。
 * 返回每个命中:{ s, e, text, before, after, line }(供 LLM 看前后文判断)。
 * 注意:原片转写是**繁体**(热词注入才变简体),故词表需含简繁两种写法。
 */
export function findTier2(segments, tier2 = [], opts = {}) {
  const set = new Set(tier2);
  if (!set.size) return [];
  const PAUSE = opts.standalonePauseSec ?? 0.12;
  const maxL = Math.max(1, ...[...set].map((w) => w.length));
  const out = [];
  let prevLine = "";
  for (const sg of segments || []) {
    if (!sg || !Array.isArray(sg.w) || !sg.w.length) continue;
    const linePrev = prevLine;
    prevLine = sg.z || prevLine;
    // chars[ch,ws,we]；cw[i]=该字第几个词；wdom[wi]=[ws,we,字数,每字时长]
    const chars = [], cw = [], wdom = [];
    const bounds = new Set([0]);
    let acc = 0;
    for (let wi = 0; wi < sg.w.length; wi++) {
      const [ws, we, word] = sg.w[wi];
      const clean = String(word || "").replace(PUNCT_RE_JS, "");
      const nc = Math.max(1, clean.length);
      wdom.push([ws, we, nc, (we - ws) / nc]);
      for (const ch of clean) { chars.push([ch, ws, we]); cw.push(wi); }
      acc += clean.length;
      bounds.add(acc);
    }
    if (!chars.length) continue;
    // whisper 词级时间戳首尾相接（词间空隙≈0）：停顿被**吸收进邻近词的时长**。
    // 故"是否有停顿"要用"某词时长 − 字数×该段典型每字时长"的**溢出量**来估，而非词间空隙。
    const pers = wdom.map((x) => x[3]).sort((a, b) => a - b);
    const TYP = pers.length ? pers[Math.floor(pers.length / 2)] : 0.12;
    const slack = (wi) => (wi < 0 || wi >= wdom.length) ? 0
      : Math.max(0, (wdom[wi][1] - wdom[wi][0]) - wdom[wi][2] * TYP);
    const text = chars.map((c) => c[0]).join("");
    for (let i = 0; i < chars.length; i++) {
      for (let L = maxL; L >= 1; L--) {
        if (i + L > chars.length) continue;
        const frag = text.slice(i, i + L);
        if (!set.has(frag)) continue;
        if (!bounds.has(i) || !bounds.has(i + L)) continue;
        const wS = cw[i], wE = cw[i + L - 1];
        let pauseBefore = 99;
        if (i > 0) {
          pauseBefore = chars[i][1] - chars[i - 1][2];            // 跨词空隙（一般≈0）
          pauseBefore = Math.max(pauseBefore, slack(wS - 1));     // 前一个词"吸收"的停顿
        }
        let pauseAfter = 99;
        if (i + L < chars.length) {
          pauseAfter = chars[i + L][1] - chars[i + L - 1][2];
          pauseAfter = Math.max(pauseAfter, slack(wE + 1));       // 后一个词"吸收"的停顿
        }
        out.push({
          s: chars[i][1], e: chars[i + L - 1][2], text: frag,
          before: text.slice(Math.max(0, i - 10), i),
          after: text.slice(i + L, i + L + 10),
          line: sg.z,
          // 该词在句段里的位置：head=段首（whisper 的段边界不是停顿，不能当作"独立成说"的证据）
          pos: i === 0 ? "head" : (i + L >= chars.length ? "tail" : "mid"),
          // 上一句原文：LLM 判断「这个/那个」是泛指垫词还是回指前文的关键上下文
          prev: linePrev,
          // 独立成说：前后都有停顿才允许剪。"那个/这个+名词"同句段内紧贴 → 不是填充词，不剪。
          standalone: pauseBefore >= PAUSE && pauseAfter >= PAUSE,
        });
        i += L - 1;
        break;
      }
    }
  }
  return out;
}
