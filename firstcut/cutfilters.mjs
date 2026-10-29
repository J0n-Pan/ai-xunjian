// 合片滤镜图 —— 首剪(run.mjs)与重剪(reexport.mjs)共用同一份，避免两边逻辑漂移。
//
// 历史坑：原先是「每段一条 [0:v]trim=s:e;… + concat」，12 段就是 12 条并行分支。
// ffmpeg 会为每条分支缓存帧，commit 内存以 ~0.3GB/s 线性上涨：
//   实测同一素材 12 段，第 1 秒 5.28GB → 第 4 秒 6.15GB，工作集 950MB→1820MB，
//   跑满一分钟冲到 21GB；8GB 机器上直接把页面文件吃干 →
//   系统事件「虚拟内存不足」→ DWM 崩溃(0xc00001ad) → 整台机器上的任务全灭。
// 现在改成单链 select/aselect：只有一条链，内存恒定（实测 commit 4.77GB、工作集 432MB，不随进度涨）。
//
// 切口淡化：硬切会让波形突跳，成片转写会把它"听"成辅音、幻觉出一个不存在的词（实测「保护」）；
// 听感上就是"啪"的一声 + 硬拼。这里每个拼接点做**对称 V 形**：拼接点前 fade 秒淡出到 0，
// 点后 fade 秒淡入回 1。
//
// ⚠️ 为什么不再用 volume 表达式（v1.1.1 及以前的做法）：
//   `volume='if(lt(abs(t-T),f),abs(t-T)/f,1)':eval=frame` 是按**音频帧**（1024 样本 ≈ 21.3ms）
//   采样 t 的，而 T 一般不在帧边界上 —— 相邻两帧的增益可能从 0.33 直接跳到 1.0，
//   既没压到 0（咔哒还在），又自己造了一个新的阶跃。实测把 f 提到 60ms 也只是把残余阶跃变小。
//   改成 afade + enable：afade 是**采样级**连续曲线，实测 1.450s→1.500s 真降到 -180dB，
//   1.500s→1.563s 平滑回升；enable 关闭时滤镜直通（增益 1），所以多段串联互不干扰。
//
// ⚠️ 曲线选 cub（三次方）：fade out 的增益是 (1-x)³，在最后 6ms 已经掉到 -62dB，
//   实测对比（点前 6ms 残留）：qsin -29.6dB / tri -33.4dB / hsin -40.7dB / qua -48.3dB / cub -62.4dB。
//   qsin 是"前慢后更慢"，恰好把最该压的末段留在满幅附近 —— 30ms 版本跨点残留只有 -15dB，
//   实测两个切在满幅语音中间的拼接点（原片 27.13 / 120.59）听起来就是"啪"。
//   exp 虽然能到 -180dB，但前 6ms 就掉了 40dB，像"突然没声"，语音上像吞字。
//   时长取 40ms：短到听不出凹陷，又足够覆盖 aselect 的一帧量化误差（21ms）。
//
// ⚠️ 拼接点位置是**估算**：aselect 按帧取舍（1024 样本一帧），实际切点与理论值最多差一帧（21ms）。
//   fade 取 40ms 时这点误差仍在窗口内（最坏情况点前 19ms 已衰减 -24dB），听不出阶跃。

const num = (x) => String(Math.round(Number(x) * 1e6) / 1e6);

/**
 * @param {Array<[number,number]>} segs 保留段（原片时间，秒，按时间升序）
 * @param {{speed?:number, fade?:number}} opts speed=提速倍数（1=不提速）；fade=拼接点单侧淡化秒数
 * @returns {string} filter_complex 文本
 */
export function buildCutFilter(segs, opts = {}) {
  const speed = Number(opts.speed) || 1;
  const fade = Math.max(0, Number(opts.fade) || 0);
  if (!Array.isArray(segs) || !segs.length) throw new Error("buildCutFilter: segs 为空");

  const expr = segs.map(([s, e]) => `between(t,${num(s)},${num(e)})`).join("+");
  const vParts = [`select='${expr}'`, "setpts=N/FRAME_RATE/TB"];
  const aParts = [`aselect='${expr}'`, "asetpts=N/SR/TB"];

  if (fade > 0 && segs.length > 1) {
    // 拼接点在**输出时间轴**上的位置 = 前面各段时长累加；afade 的 st 也是输出时间轴
    let acc = 0;
    const f = num(fade);
    for (let i = 0; i < segs.length - 1; i++) {
      acc += segs[i][1] - segs[i][0];
      const a0 = num(acc - fade), a1 = num(acc), a2 = num(acc + fade);
      // 淡出：只在前 fade 秒内启用，过了拼接点就直通，避免把后面整段压没
      aParts.push(`afade=t=out:st=${a0}:d=${f}:curve=cub:enable='between(t,${a0},${a1})'`);
      // 淡入：从拼接点起从 0 升到 1
      aParts.push(`afade=t=in:st=${a1}:d=${f}:curve=cub:enable='between(t,${a1},${a2})'`);
    }
  }
  if (Math.abs(speed - 1) > 1e-9) {
    vParts.push(`setpts=PTS/${speed}`);
    aParts.push(`atempo=${speed}`);
  }
  return `[0:v]${vParts.join(",")}[vf];[0:a]${aParts.join(",")}[af]`;
}
