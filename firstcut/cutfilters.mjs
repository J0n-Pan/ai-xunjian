// 合片滤镜图 —— 首剪(run.mjs)与重剪(reexport.mjs)共用同一份，避免两边逻辑漂移。
//
// 历史坑：原先是「每段一条 [0:v]trim=s:e;… + concat」，12 段就是 12 条并行分支。
// ffmpeg 会为每条分支缓存帧，commit 内存以 ~0.3GB/s 线性上涨：
//   实测同一素材 12 段，第 1 秒 5.28GB → 第 4 秒 6.15GB，工作集 950MB→1820MB，
//   跑满一分钟冲到 21GB；8GB 机器上直接把页面文件吃干 →
//   系统事件「虚拟内存不足」→ DWM 崩溃(0xc00001ad) → 整台机器上的任务全灭。
// 现在改成单链 select/aselect：只有一条链，内存恒定（实测 commit 4.77GB、工作集 432MB，不随进度涨）。
//
// 边界淡化不能丢：硬切会让波形突跳，成片转写会把它"听"成辅音、幻觉出一个不存在的词（实测「保护」）。
// 原来靠每段 afade out + 下一段 afade in；单链版本用 volume 的 V 形衰减还原同一效果 ——
// 每个拼接点前后各 fade 秒把增益压到 0。eval=frame 的精度是一个音频帧（48k/1024≈21ms），
// 足够压掉单采样尖峰，且仍是常量内存。

const num = (x) => String(Math.round(Number(x) * 1e6) / 1e6);

/**
 * @param {Array<[number,number]>} segs 保留段（原片时间，秒，按时间升序）
 * @param {{speed?:number, fade?:number}} opts speed=提速倍数（1=不提速）；fade=拼接点淡化秒数
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
    // 拼接点在**输出时间轴**上的位置 = 前面各段时长累加；volume 的 t 也是输出时间轴
    let acc = 0;
    const f = num(fade);
    for (let i = 0; i < segs.length - 1; i++) {
      acc += segs[i][1] - segs[i][0];
      const T = num(acc);
      aParts.push(`volume='if(lt(abs(t-${T}),${f}),abs(t-${T})/${f},1)':eval=frame`);
    }
  }
  if (Math.abs(speed - 1) > 1e-9) {
    vParts.push(`setpts=PTS/${speed}`);
    aParts.push(`atempo=${speed}`);
  }
  return `[0:v]${vParts.join(",")}[vf];[0:a]${aParts.join(",")}[af]`;
}
