# -*- coding: utf-8 -*-
# 转写 + 字幕构建：faster-whisper 词级时间戳 → ≤N字/行的逐字字幕
# 用法: uv run --with faster-whisper python asr_and_caps.py <音频.wav> <输出caps.json> [模型名] [句段输出.json]
# 第4参可选：把 whisper 原始句段(未拆行)另存一份——重说口误检测要按整句比相似度，拆行后比不准
# 参数真源：firstcut/rules.json（可用 XUNJIAN_RULES 指定别的路径；缺失则用内置默认并告警）
import sys, json, os, re

audio, out = sys.argv[1], sys.argv[2]

# ── 读 rules.json（与内置默认深合并；缺文件用默认并告警，绝不静默）──
_DEFAULTS = {
    "asr": {
        "model": "small", "beamSize": 5, "vadMinSilenceMs": 300, "language": "zh",
        # ── 分块转写 + 覆盖缺口检测（v4）──
        # whisper 在"长音频 + 长 initial_prompt"下会整段跳读(实测 C0777 丢 30s)。分块把每次
        # 解码限制在 chunkSec 秒内，跳读无从发生；随后按"未被任何句段覆盖的 >coverageGapSec
        # 且确有语音能量的区段"回炉补转，直到缺口=0 或无可补。
        "chunkSec": 20.0,
        "chunkOverlapSec": 0.5,
        "coverageGapSec": 2.5,
        "chunkRetry": 3,
        "speechRms": 0.012,
    },
    "caption": {
        "maxCharsPerLine": 14,
        # ── 字幕版式（v4）──
        # "sentence": 卡 = 一个 whisper VAD 句段(=逗号级小句)；句段超长才在同句内拆行(依次出现)。
        # "pack"    : 旧版"全片拼字 + 跨句 DP 装箱"(会一句跨卡/两句并卡)，留作回滚。
        "layout": "sentence",
        "spaceBreakMinChars": 8,
        "wordBoundary": True,
        "userDict": [],
        "stripPunct": "，,。.、；;：:！!？?…—·\"“”'‘’（）()《》〈〉【】 ",
        "fixes": [],
    },
}


def _load_rules():
    p = os.environ.get("XUNJIAN_RULES") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "rules.json")
    if not os.path.exists(p):
        sys.stderr.write("⚠️ asr_and_caps: 未找到 rules.json(%s)，使用内置默认\n" % p)
        return json.loads(json.dumps(_DEFAULTS))
    try:
        with open(p, encoding="utf-8") as f:
            j = json.load(f)
    except Exception as e:
        sys.stderr.write("⚠️ asr_and_caps: rules.json 解析失败(%s)，使用内置默认\n" % e)
        return json.loads(json.dumps(_DEFAULTS))
    out = json.loads(json.dumps(_DEFAULTS))
    for grp, vals in j.items():
        if isinstance(vals, dict) and isinstance(out.get(grp), dict):
            out[grp].update(vals)
        elif grp in out:
            out[grp] = vals
    return out


RULES = _load_rules()

# 模型优先级: CLI 参数 > 环境变量 XUNJIAN_WHISPER_MODEL > rules.json > 内置默认
model_name = (sys.argv[3] if len(sys.argv) > 3
              else os.environ.get("XUNJIAN_WHISPER_MODEL") or RULES["asr"]["model"])
segs_out = sys.argv[4] if len(sys.argv) > 4 else None

# ── ASR 错字订正词典（来自 rules.json caption.fixes）──
# 转写常把英文品牌/术语拆错，按你的领域往 rules.json 里加即可；[错误写法, 正确写法] 有序生效
FIXES = RULES["caption"]["fixes"]

# 烧进画面的逐字字幕不该带标点：注入了热词提示后 whisper 会产出带逗号句号的文本
# (原基准模型不产出)，标点既多余又挤占每行字数 → 字幕统一清除，raw_segs 保留原样。
CAP_STRIP = RULES["caption"]["stripPunct"]

MAX = RULES["caption"]["maxCharsPerLine"]          # 每行最多字数（竖屏单行不换行的安全值）
SPACE_MIN = RULES["caption"]["spaceBreakMinChars"]  # 空格短语界断行时，当前行至少已有多少字
BEAM = RULES["asr"]["beamSize"]
VAD_MS = RULES["asr"]["vadMinSilenceMs"]
LANG = RULES["asr"]["language"]
# 分块转写 + 覆盖缺口检测（v4，见 _DEFAULTS.asr 注释）
CHUNK_SEC = float(RULES["asr"].get("chunkSec", 20.0))
CHUNK_OVL = float(RULES["asr"].get("chunkOverlapSec", 0.5))
COV_GAP = float(RULES["asr"].get("coverageGapSec", 2.5))
COV_RETRY = int(RULES["asr"].get("chunkRetry", 3))
COV_RMS = float(RULES["asr"].get("speechRms", 0.012))
# 密度体检（v4.1）：句段"跨了很长时长却几乎没字" = whisper 在块内跳读（实测 C0793 一个 20s 段只出 9 字）。
# 单看"区间覆盖"查不出这类缺口（段把时间盖住了），必须另开一条"字/秒"轴。
DENS_CPS = float(RULES["asr"].get("minCharsPerSec", 1.2))
DENS_SPAN = float(RULES["asr"].get("densityMinSpanSec", 2.5))
REFINE_SEC = float(RULES["asr"].get("refineChunkSec", 6.0))
# 分块开关：XUNJIAN_ASR_CHUNK=off 可关回单次整段转写（排查用）
CHUNK_ON = (os.environ.get("XUNJIAN_ASR_CHUNK") or "on").strip().lower() not in ("off", "0", "false", "none")
# 段级复核：分块转写（20s）里 whisper small 会吞掉短词——实测 C0779
# 「孩子看到脸上是[这个]比较松弛的」，20s 块整句丢「这个」，导致下游语气词检测**根本无候选**
# （不是护栏拦的）。段级重转（每段独立、上下文短）能把这类短词找回来。
# 只输出 `raw-segs-fine.json` 供语气词候选使用，**不参与分段结构与字幕**，故文本偏差不影响成片结构。
SEGCHECK_ON = (os.environ.get("XUNJIAN_SEGCHECK") or "on").strip().lower() not in ("off", "0", "false", "none")
SEGCHECK_CHUNK = float(os.environ.get("XUNJIAN_SEGCHECK_CHUNK") or RULES["asr"].get("segcheckChunkSec", 8.0))
CAP_LAYOUT = str(RULES["caption"].get("layout", "sentence")).strip().lower()


# ── 领域热词（解码提示）──
# whisper 对不在上下文中的专有名词/术语几乎必错。把领域词汇作为提示喂进解码器，
# 可显著降低这类错字（实测「李维→李威」「世界级→世界记忆」「支点→知识点」等）。
#
# 但实测发现：只要注入提示，whisper 就会把整片解码成"一段带标点的连续文本"，
# VAD 切分的段落全被合并（13 段 → 1 段）。而下游"重说/卡壳检测"依赖多段比对，
# 段数塌成 1 就会完全空转。故提示只用于"成片字幕"这一步；转写原片做重说检测时
# 必须关掉（由 run.mjs 传 XUNJIAN_ASR_HOTWORDS=off），两处各取所需。
def _hotwords():
    """auto(默认)=读同目录 hotwords.txt；off/none/0/false=不注入；其它=直接作为提示词"""
    mode = (os.environ.get("XUNJIAN_ASR_HOTWORDS") or "auto").strip()
    if mode.lower() in ("off", "none", "0", "false"):
        return ""
    if mode.lower() != "auto":
        return mode
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hotwords.txt")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            # 跳过以 # 开头的注释行，其余按行拼接成提示词
            return " ".join(x.strip() for x in f if x.strip() and not x.lstrip().startswith("#"))
    return ""


HOT = _hotwords()


# ── 分块转写 + 覆盖缺口检测（v4）──────────────────────────────────────────────
# 背景：whisper 在「长音频 + 长 initial_prompt(热词)」下会整段跳读（实测 C0777 成片丢 0.9~30.7s、
# C0779 丢片头 13s；且关不关热词都可能丢——C0793 关热词只剩 17 字）。单次整段转写无法自证覆盖。
# 做法：① 按 chunkSec 切成互有重叠的小块分别转写（每块 ≤20s，跳读无从发生）；
#       ② 合并去重；③ 找「未被任何句段覆盖、时长 ≥coverageGapSec、且确有语音能量」的区段回炉补转；
#       ④ 迭代到缺口=0 或无可补。缺口是有语音能量却没进转写的部分，这里必须为 0。
class _W2:
    __slots__ = ("start", "end", "word")
    def __init__(self, a, b, c): self.start, self.end, self.word = a, b, c


class _Seg:
    __slots__ = ("start", "end", "text", "words")
    def __init__(self, a, b, t, ws=()): self.start, self.end, self.text, self.words = a, b, t, list(ws)


# ── 繁转简（v5.1）────────────────────────────────────────────────────────────
# 背景：关掉热词提示后，whisper small 的 zh 输出会走**繁体字形**（热词提示里含简体才会转简体）。
# 实测 v5-C0793 整片繁体（「現在備戰期中/我是世界級冠軍李威」），字幕直接不合格。
# 不能改用「短 prompt 引导简体」：实测 17 个 VAD 句段会被合并成 3~9 段，
# 直接破坏「卡=句段」的字幕结构（段变长 → 拆成两行/三行）。
# 故改为**后处理**：优先 zhconv（纯 python，无 C 扩展）；不可用时用内置高频字表兜底。
T2S_ON = bool(RULES.get("asr", {}).get("t2s", True)) and \
    (os.environ.get("XUNJIAN_T2S") or "on").strip().lower() not in ("off", "0", "false", "none")

# 内置兜底表：只收口语高频字（zhconv 缺失时兜底，覆盖主要用字即可）。
_T2S_PAIRS = (
    "這这 個个 們们 現现 備备 戰战 級级 軍军 僅仅 夠够 幫帮 認认 識识 機机 記记 麼么 "
    "開开 關关 習习 題题 兒儿 說说 話话 時时 間间 對对 過过 還还 讓让 覺觉 為为 樣样 "
    "難难 聽听 應应 該该 學学 實实 會会 動动 態态 種种 類类 點点 總总 結结 從从 來来 "
    "後后 進进 裡里 邊边 嗎吗 讀读 寫写 講讲 語语 詞词 義义 誤误 書书 畫画 張张 門门 "
    "問问 陽阳 場场 長长 麼 見见 覺觉 認认 為为 親亲 愛爱 媽妈 爸爸 爺爷 兒儿 媳妇 "
    "媽妈 師师 課课 練练 習习 績绩 試试 驗验 測测 評评 準准 標标 準准 確确 認认 細细 "
    "節节 環环 境境 氣气 溫温 熱热 冷热 燈灯 光光 電电 視视 網网 絡络 訊讯 號号 碼码 "
    "價价 錢钱 貴贵 買买 賣卖 費费 賺赚 輸输 贏赢 幫帮 助助 擔担 負负 責责 任任 務务 "
    "計计 劃划 辦办 公工 司司 業业 產产 品質 量量 數数 據据 統统 計计 圖图 標标 準准 "
    "簡简 單单 複复 雜杂 難难 易易 開开 始始 結结 束束 完完 成成 繼继 續续 準准 備备 "
    "記记 憶忆 憶忆 專专 注注 意意 力力 效效 率率 學学 習习 習习 慣惯 練练 習习 題题 "
    "錯错 誤误 改改 正正 進进 步步 提提 高高 降降 低低 增增 加加 減减 少少 變变 化化 "
    "現现 場场 直直 播播 間间 觀观 眾众 粉粉 絲丝 優优 惠惠 福福 利利 贈赠 送送 免免 "
    "費费 價价 值值 課课 程程 老師 學學 員员 家家 長长 孩孩 子子 媽媽 爸爸 情情 緒绪 "
    "溝沟 通通 表表 達达 語语 言言 表表 情情 環环 境境 氛氛 圍围 狀状 態态 冷冷 靜静 "
    "發发 火火 罵骂 鼓鼓 勵励 誇夸 獎奖 懲惩 罰罚 壓压 力力 焦焦 慮虑 開心 快快 樂乐 "
    "記记 得得 忘忘 記记 想想 法法 觀观 念念 認认 知知 邏逻 輯辑 思思 維维 創创 造造 "
)


def _build_t2s():
    table = {}
    for pair in _T2S_PAIRS.split():
        if len(pair) >= 2:
            table[ord(pair[0])] = pair[1:]
    return str.maketrans(table)


_T2S_TABLE = _build_t2s()
_T2S_FN = None
if T2S_ON:
    try:
        import zhconv as _zhconv
        _T2S_FN = lambda t: _zhconv.convert(t, "zh-cn") if t else t   # 幂等：简体输入原样返回
        sys.stderr.write("ℹ️ 繁转简：使用 zhconv\n")
    except Exception:
        _T2S_FN = lambda t: t.translate(_T2S_TABLE) if t else t
        sys.stderr.write("ℹ️ 繁转简：zhconv 不可用，使用内置高频字表\n")


def _t2s(text):
    return _T2S_FN(text) if (_T2S_FN and text) else text


def _t2s_segs(segs):
    """只换文本、保留原句段时间戳；词级时间戳一并转，保证字幕/词级检测口径一致。"""
    out = []
    for s in segs:
        out.append(_Seg(s.start, s.end, _t2s(s.text or ""),
                        [_W2(w.start, w.end, _t2s(w.word or "")) for w in (s.words or [])]))
    return out


def _read_wav_mono16k(path):
    """读 16k 单声道 s16 wav → (float32 numpy[0,1], sr)。分块切片要按样本数算。"""
    import wave, array
    import numpy as np
    w = wave.open(path, "rb")
    try:
        if not (w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2):
            raise RuntimeError("分块转写要求 16k/单声道/s16，实为 %d/%d/%d"
                               % (w.getframerate(), w.getnchannels(), w.getsampwidth()))
        a = array.array("h"); a.frombytes(w.readframes(w.getnframes()))
    finally:
        w.close()
    return np.frombuffer(a.tobytes(), dtype="<i2").astype("float32") / 32768.0, 16000


def _rms_has_speech(samples, sr, a, b):
    """该区段是否有语音能量（避免把真静音也当缺口回炉）。按 30ms 帧取最大 RMS。"""
    import numpy as np
    x = samples[int(max(0, a) * sr):int(max(0, b) * sr)]
    if x.size == 0:
        return False
    fr = int(0.03 * sr)
    if fr < 1 or x.size < fr:
        return float(np.sqrt(np.mean(x.astype("float64") ** 2))) > COV_RMS
    m = 0.0
    for i in range(0, x.size - fr + 1, fr):
        r = float(np.sqrt(np.mean(x[i:i + fr].astype("float64") ** 2)))
        if r > m:
            m = r
    return m > COV_RMS


_ONLY_TXT_RE = re.compile(r"[^\u4e00-\u9fffa-zA-Z0-9]")


def _merge_text_overlap(segs):
    """相邻句段在**文本上**重复 → 合并（分块转写的块边界典型故障）。

    实测 v6-C0777：20s 块边界处产出「一个情绪平」(5字/0.96s) +「情绪平和」(4字/0.3s) 两段，
    时间上首尾相接、内容上后者是前者的尾巴重说 —— 时间重叠判据抓不到，成片就是
    「一个情绪平」「情绪平和」两张卡，且第一张是被劈开的半句。
    判据：时间相接(gap ≤ textOverlapGapSec) 且 前段尾部 == 后段头部（重叠 ≥3 字）→ 合并去重。
    正常的口播重说间隔都 >0.15s，不会被误合。
    """
    if len(segs) < 2:
        return segs
    out = [segs[0]]
    for s in segs[1:]:
        p = out[-1]
        a = _ONLY_TXT_RE.sub("", p.text or "")
        b = _ONLY_TXT_RE.sub("", s.text or "")
        gap = s.start - p.end
        if a and b and gap <= 0.15:
            best = 0
            for k in range(min(len(a), len(b)), 2, -1):
                if a[-k:] == b[:k]:
                    best = k
                    break
            if best:
                # 保留后段原文（含短语空格），只砍掉开头重复的前 best 个汉字
                bt = (s.text or "").strip()
                cnt, cut = 0, len(bt)
                for idx, ch in enumerate(bt):
                    if _ONLY_TXT_RE.match(ch) is None:
                        cnt += 1
                    if cnt >= best:
                        cut = idx + 1
                        break
                rest = bt[cut:].strip()
                merged = (p.text or "").strip() + (" " + rest if rest else "")
                out[-1] = _Seg(p.start, s.end, merged,
                               list(p.words or []) + list(s.words or []))
                continue
        out.append(s)
    return out


def _merge_dedupe(raw):
    """重叠窗口会产生重复句段：按时序保留、丢弃与已保留段重叠 >60% 的重复；
    再对**残余的部分重叠**做一次裁剪（起点推到前段末尾），避免字幕出现两张卡在时间上重叠
    （实测 C0779/C0793 各有 1~3 处 0.1~0.3s 的子卡重叠）。"""
    raw = sorted([x for x in raw if x[2].strip()], key=lambda x: x[0])
    kept = []
    for s, e, txt, ws in raw:
        dur = max(0.01, e - s)
        if any((min(e, ke) - max(s, ks)) > 0.6 * dur and (min(e, ke) - max(s, ks)) > 0.15
               for ks, ke, _, _ in kept):
            continue
        kept.append((s, e, txt, ws))
    kept.sort(key=lambda x: x[0])
    out = []
    for s, e, txt, ws in kept:
        if out:
            pe = out[-1][1]
            if s < pe - 0.02:
                if e <= pe + 0.02:
                    continue                # 被前段完全盖住（块边界重复）→ 丢
                s = pe                      # 部分重叠 → 起点推到前段末尾
        if e - s < 0.05:
            continue
        out.append((s, e, txt, ws))
    return _merge_text_overlap([_Seg(s, e, t, [_W2(*w) for w in ws]) for (s, e, t, ws) in out])


def _coverage_gaps(segs, total, samples=None, sr=16000):
    """返回「有语音能量却未被任何句段覆盖」且 ≥COV_GAP 的区段列表。"""
    ivs = []
    for s in segs:
        ivs.append((s.start, s.end))
    ivs.sort()
    merged = []
    for a, b in ivs:
        if merged and a <= merged[-1][1] + 0.02:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    gaps, prev = [], 0.0
    for a, b in merged:
        if a - prev >= COV_GAP:
            gaps.append((prev, a))
        prev = max(prev, b)
    if total - prev >= COV_GAP:
        gaps.append((prev, total))
    if samples is not None:
        gaps = [g for g in gaps if _rms_has_speech(samples, sr, g[0], g[1])]
    return gaps


def _sparse_spans(segs):
    """密度体检：返回"跨时长很长、字却很少"的句段区间（whisper 块内跳读的指纹）。"""
    out = []
    for s in segs:
        span = s.end - s.start
        if span < DENS_SPAN:
            continue
        n = len(re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", s.text or ""))
        if n / max(0.01, span) < DENS_CPS:
            out.append((s.start, s.end))
    return out


def _refine_windows(a, b):
    """把长区间切成 ~REFINE_SEC 的小块：整段一次转写模型容易跳读，切碎则无从跳。"""
    out, t = [], a
    while t < b - 0.15:
        out.append((t, min(b, t + REFINE_SEC)))
        t += REFINE_SEC
    return out or [(a, b)]


def _drop_within(got, a, b):
    """丢弃完全落在 [a,b] 内的旧原始句段（它们是被判"稀疏"的坏段，由回炉结果替代）。"""
    return [x for x in got if not (x[0] >= a - 0.05 and x[1] <= b + 0.05)]


def _chunked_transcribe(path, tx, chunk_sec=None):
    samples, sr = _read_wav_mono16k(path)
    total = len(samples) / float(sr)
    CS = float(chunk_sec or CHUNK_SEC)
    step = max(4.0, CS - CHUNK_OVL)
    wins, t = [], 0.0
    while t < total - 0.05:
        e = min(total, t + CS)
        wins.append((t, e))
        if e >= total:
            break
        t += step
    got = []
    for (a, b) in wins:
        try:
            ss, _ = tx(samples[int(a * sr):int(b * sr)], a)
        except Exception as ex:
            sys.stderr.write("⚠️ 分块转写 %.1f-%.1f 失败: %s\n" % (a, b, ex))
            continue
        got.extend(ss)
    segs = _merge_dedupe(got)
    for it in range(COV_RETRY):
        # 两条检测轴：① 完全没被覆盖的区段；② 被覆盖但"跨时长却几乎没字"的稀疏段
        gaps = _coverage_gaps(segs, total, samples, sr)
        sparse = _sparse_spans(segs)
        targets = gaps + sparse
        if not targets:
            break
        added = 0
        for (ga, gb) in targets:
            a, b = max(0.0, ga - 0.3), min(total, gb + 0.3)
            if gb - ga > REFINE_SEC * 1.5:            # 长缺口/长稀疏段 → 切碎回炉
                got = _drop_within(got, ga, gb)
                subs = _refine_windows(a, b)
            else:
                subs = [(a, b)]
            for (wa, wb) in subs:
                try:
                    ss, _ = tx(samples[int(wa * sr):int(wb * sr)], wa)
                except Exception:
                    continue
                for (s, e, txt, ws) in ss:
                    if txt.strip():
                        got.append((s, e, txt, ws)); added += 1
        if not added:
            break
        segs = _merge_dedupe(got)
    _gl = _coverage_gaps(segs, total, samples, sr)
    _sp = _sparse_spans(segs)
    print("ASR_CHUNK wins=%d segs=%d dur=%.1fs gaps=%d sparse=%d"
          % (len(wins), len(segs), total, len(_gl), len(_sp)))
    return segs


# 离线快速迭代入口:设 XUNJIAN_BREAK_FROM_SEGS=<句段dump.json>(由 XUNJIAN_DUMP_SEGWORDS 产出),
# 跳过 whisper,直接用已有句段重建字幕——只用于调断行算法,正式流程不用。
_SRC = os.environ.get("XUNJIAN_BREAK_FROM_SEGS")
if _SRC:
    class _W:
        __slots__ = ("start", "end", "word")
        def __init__(self, st, en, wo): self.start, self.end, self.word = st, en, wo
    class _S:
        __slots__ = ("start", "end", "text", "words")
        def __init__(self, o):
            self.start, self.end, self.text = o["s"], o["e"], o["z"]
            self.words = [_W(*x) for x in o.get("w", [])]
    with open(_SRC, encoding="utf-8") as _f:
        segs = [_S(o) for o in json.load(_f)]
    print("ASR_HOTWORDS=replay")
else:
    from faster_whisper import WhisperModel
    m = WhisperModel(model_name, device="cpu", compute_type="int8")
    # 开 VAD:不连贯的口播(如直播间)会被 whisper 合并成一个超长句段,导致下游"重说检测"
    # 无句可比、永远空转。VAD 按停顿切段后句段数从 1 → 十几段,重说检测才真正生效。
    kw = {"initial_prompt": HOT} if HOT else {}

    def _tx(audio_in, offset=0.0):
        """转写一段音频(路径或 float32 ndarray)，返回 [(abs_s, abs_e, text, [(ws,we,word)...])]。"""
        it, _info = m.transcribe(
            audio_in, language=LANG, beam_size=BEAM, word_timestamps=True,
            # 关掉"以上文续写"：分块时各块独立，避免上一块的幻觉/跳读污染下一块
            condition_on_previous_text=False,
            vad_filter=True, vad_parameters={"min_silence_duration_ms": VAD_MS}, **kw)
        out = []
        for s in it:
            out.append((s.start + offset, s.end + offset, s.text,
                        [(w.start + offset, w.end + offset, w.word) for w in (s.words or [])]))
        return out, _info

    print(f"ASR_HOTWORDS={'on' if HOT else 'off'}")
    if CHUNK_ON:
        segs = _chunked_transcribe(audio, _tx)
    else:
        _ss, info = _tx(audio)
        segs = _merge_dedupe(_ss)
        print(f"ASR_CHUNK off segs={len(segs)} dur={getattr(info, 'duration', 0):.1f}s")

# ── 细通道复核（只补语气词候选，不改结构）──
# 用 8s 小分块再转一遍：短上下文能保住「这个/那个」这类被 20s 块吞掉的短词，
# 代价是整体错字更多 —— 所以它**只提供"某处有个语气词"的位置**，
# 上下文由 run.mjs 用主通道文本回填。分段结构与字幕一律用主通道结果。
if SEGCHECK_ON and segs_out:
    _fp = os.path.join(os.path.dirname(segs_out) or ".", "raw-segs-fine.json")
    try:
        _fine_segs = _chunked_transcribe(audio, _tx, SEGCHECK_CHUNK)
        _fine = []
        for _sg in _fine_segs:
            _t = getattr(_sg, "text", "") or ""
            if not _t.strip():
                continue
            _fine.append({
                "s": round(_sg.start, 2), "e": round(_sg.end, 2), "z": _t2s(_t.strip()),
                "w": [[round(_w.start, 2), round(_w.end, 2), _t2s(_w.word or "")] for _w in (_sg.words or [])],
            })
        if _fine:
            with open(_fp, "w", encoding="utf-8") as _f:
                json.dump(_fine, _f, ensure_ascii=False)
            print("ASR_SEGCHECK segs=%d (chunk=%.1fs) → %s" % (len(_fine), SEGCHECK_CHUNK, os.path.basename(_fp)))
    except Exception as _ex:
        sys.stderr.write("⚠️ 细通道复核失败: %s\n" % _ex)

# 断行用的标点集合：注入热词提示后 whisper 会输出带标点的文本（原基准模型不带），
# 此时"空格开头=短语边界"的规则失效、分词也不一样，改用"标点即短语边界"来断行。
#
# 注意：不能只按 stripPunct 白名单剔除——whisper 会吐出全角/小写变体标点
# （实测漏过 U+FE51「﹑」、U+FE52「﹒」、U+30FB「・」、U+301C「〜」等），
# 白名单永远列不全。这里改为**黑名单**：凡不是「汉字/ASCII 字母数字」的字符一律不当正文，
# 既能当断点标记、又能彻底防止标点漏进成片字幕。
_NON_TXT = re.compile(r"[^\u4e00-\u9fffa-zA-Z0-9]")
PUNCT_RE = _NON_TXT
WORD_BOUNDARY = bool(RULES["caption"].get("wordBoundary", True))

# jieba 中文分词:whisper 的中文"词"粒度实际是单字(word_timestamps 逐字输出),
# 直接按字数断行会切词(「关/系」「紧/张的」)。改用 jieba 得到真正的词边界,
# 断行只在词边界(或标点边界)上切,从而同时消除"切词"与"1 字碎行"。
# 关闭方式:rules.caption.wordBoundary=false(回退旧的字数硬断)。
if WORD_BOUNDARY:
    try:
        import jieba
        jieba.setLogLevel(30)                       # 静默 DEBUG/INFO 日志
        for _w in RULES["caption"].get("userDict", []):
            jieba.add_word(_w)                      # 专名/术语不被拆开
    except Exception as _e:
        sys.stderr.write("⚠️ asr_and_caps: jieba 不可用(%s)，回退字数硬断\n" % _e)
        WORD_BOUNDARY = False

# ── 断行优选参数（见 rules.json caption；仅 WORD_BOUNDARY 时有意义）──
# wordBoundary 只保证"不切词"，但"离均分点最近的词边界"仍会断在「跟/不/是/那个/做」等
# 语义中途。phraseAware=true 时改用「停顿/标点/禁词」打分 + DP 求全局最优断点。
PHRASE_AWARE = bool(RULES["caption"].get("phraseAware", True)) and WORD_BOUNDARY
PAUSE_SEC = float(RULES["caption"].get("pauseSec", 0.18))
MIN_LINE = int(RULES["caption"].get("minLineChars", 3))
_BR = RULES["caption"].get("breakRules") or {}
FORBID_END = set(_BR.get("forbidEndWords", []))
FORBID_START = set(_BR.get("forbidStartWords", []))
CLAUSE_START = set(_BR.get("clauseStartWords", []))
FORBID_END_CHARS = {w for w in FORBID_END if len(w) == 1}
FORBID_START_CHARS = {w for w in FORBID_START if len(w) == 1}

# ── 短语胶合表：命中短语的内部一律禁止断行（补 jieba 词典没有的固定搭配）──
GLUE = RULES["caption"].get("gluing") or []


def _glue_forbid(text):
    """返回全片文本里「不许切」的字符位置集合（胶合短语的内部位置）。"""
    bad = set()
    for ph in GLUE:
        if len(ph) < 2:
            continue
        k = text.find(ph)
        while k >= 0:
            for off in range(1, len(ph)):
                bad.add(k + off)
            k = text.find(ph, k + 1)
    return bad

# ── LLM 断行复核开关（默认读 rules.caption.breakLlm；XUNJIAN_BREAK_LLM=off 强制关）──
BREAK_LLM = bool(RULES["caption"].get("breakLlm", False))
if (os.environ.get("XUNJIAN_BREAK_LLM") or "").strip().lower() in ("off", "0", "false", "none"):
    BREAK_LLM = False


def _break_lines(chars, cut_after):
    """把全片"字"序列断成 ≤MAX 字的行,只在 jieba 词边界/标点边界处切。

    输入是全片拼接后的"字"序列(每字携带来源词的时间戳)与"标点后"切点集合
    (由调用方跨句段累积,故**全片统一断行**——避免 whisper 分段边界把词切开,
    段间停顿天然成为高分断点)。

    断行策略(phraseAware=true,默认):
      给每个候选切点打分——词间停顿(说话人自己顿了=最像语义停顿)/标点后 加分,
      行尾落在虚词(是·不·跟·那个…)/行首落在(的·了·吗…)/右词是分句起头词 分别加减,
      再用 DP 在「行数=⌈N/MAX⌉、每行≤MAX 且≥MIN_LINE」约束下求全局最优切分。
    关闭方式:rules.caption.phraseAware=false(退回旧的均分版)。
    """
    N = len(chars)
    if not N:
        return []
    text = "".join(c[0] for c in chars)
    glue = _glue_forbid(text)          # 胶合短语内部位置：禁止断行

    # 建立词序列与"每个字属于哪个词"，用于判断切点两侧的词
    words_list, word_id = [], []
    if WORD_BOUNDARY:
        for wd in jieba.lcut(text):
            words_list.append(wd)
            word_id.extend([len(words_list) - 1] * len(wd))
    else:
        words_list = list(text)
        word_id = list(range(N))

    if not PHRASE_AWARE:
        # ── 旧行为:词边界内"最少行数下均匀分配"(固定为回退路径)──
        if WORD_BOUNDARY:
            bounds = set(cut_after)
            i = 0
            for wd in words_list:
                i += len(wd)
                bounds.add(i)
        else:
            bounds = set(range(1, N + 1))
        bounds -= glue
        bounds.add(N)
        k = max(1, -(-N // MAX))
        ends, prev = [], 0
        for i in range(1, k):
            target = N * i // k
            lo = max(prev + 1, N - (k - i) * MAX)
            hi = min(prev + MAX, N - (k - i))
            cands = [p for p in bounds if lo <= p <= hi]
            b = min(cands, key=lambda p: (abs(p - target), p)) if cands else hi
            ends.append(b); prev = b
        ends.append(N)
        out, pos = [], 0
        for e in ends:
            seg = chars[pos:e]
            out.append({"s": round(seg[0][1], 2), "e": round(seg[-1][2], 2),
                        "z": "".join(c[0] for c in seg)})
            pos = e
        return out

    # ── 断行优选(DP)──
    # jbound = jieba 词边界；cut_after = 标点后/句段边界。二者取并集作为"可切点"，
    # 但**只有落在词边界上的 cut_after 才享受加分**——whisper 的句段边界会落在词内部
    # （实测「灯光」被切成「灯|光」、「改善」被切成「改|善」），若一概加分，DP 会优先选择这种
    # "把词断成两行"的坏切点。留在 bounds 里只是兜底（无更好选择时才用），不加分。
    jbound = set()
    if WORD_BOUNDARY:
        i = 0
        for wd in words_list:
            i += len(wd)
            jbound.add(i)
    else:
        jbound = set(range(1, N + 1))
    bounds = (set(cut_after) | jbound) - glue
    bounds.add(N)

    def break_penalty(p):
        """切点 p 的代价(越小越好)；只对内部切点计。"""
        if p <= 0 or p >= N:
            return 0.0
        pen = 0.0
        lc, rc = text[p - 1], text[p]
        lw, rw = words_list[word_id[p - 1]], words_list[word_id[p]]
        if lw in FORBID_END or lc in FORBID_END_CHARS:
            pen += 6.0                              # 行尾落在虚词/连接词
        if rw in FORBID_START or rc in FORBID_START_CHARS:
            pen += 6.0                              # 行首落在虚词
        if rw in CLAUSE_START:
            pen -= 2.0                              # 右词是分句起头 → 好的断点
        if p in cut_after and p in jbound:
            pen -= 3.0                              # 标点/段界后(且不切词)
        gap = chars[p][1] - chars[p - 1][2]         # 词间停顿(负值=同一词内)
        if gap >= PAUSE_SEC:
            pen -= 3.0
        return pen

    k0 = max(1, -(-N // MAX))
    INF = float("inf")
    LINE_COST = 2.0                                 # 每多一行的固定代价(避免为消除个别坏断点把行切太碎)

    def solve(kk):
        dps = [None] * (kk + 1)
        pars = [None] * (kk + 1)
        dp = [INF] * (N + 1); dp[0] = 0.0
        dps[0], pars[0] = dp, None
        for j in range(1, kk + 1):
            ndp = [INF] * (N + 1); npar = [-1] * (N + 1)
            for e in range(1, N + 1):
                best, bp = INF, -1
                for p in range(max(0, e - MAX), e):
                    if dp[p] == INF:
                        continue
                    if p > 0 and p not in bounds:
                        continue
                    L = e - p
                    if L < 1 or (L < MIN_LINE and e != N):
                        continue
                    # 主项=断点质量;微项=(MAX-L)^2 作为均衡的次级偏好(量级 < 1,不压过断点分)
                    c = dp[p] + (break_penalty(p) if p > 0 else 0.0) + 0.01 * (MAX - L) ** 2
                    if c < best:
                        best, bp = c, p
                ndp[e], npar[e] = best, bp
            dps[j], pars[j] = ndp, npar
            dp = ndp
        return dps, pars

    # 行数不再钉死在 k0:在 [k0, k0+2] 里取「断点质量 + 行数代价」最优——
    # 固定行数会把个别坏断点"逼"出来(实测:孩子不好|的时候),允许多一两行可换成自然断点。
    chosen = None
    for kk in range(k0, k0 + 3):
        dps2, pars2 = solve(kk)
        v = dps2[kk][N]
        if v == INF:
            continue
        total = v + LINE_COST * kk
        if chosen is None or total < chosen[0]:
            chosen = (total, kk, dps2, pars2)
    if chosen is None:                              # 仍不可行(单个 jieba 词长于 MAX):退化为任意字间可切
        bounds = set(range(1, N + 1))
        dps2, pars2 = solve(k0)
        chosen = (0.0, k0, dps2, pars2)
    _, k, dps, pars = chosen
    # 回溯切点
    e, cuts = N, [N]
    for j in range(k, 0, -1):
        p = pars[j][e]
        if p is None or p < 0:
            break
        cuts.append(p); e = p
    cuts = sorted(set(cuts))
    if cuts[0] != 0:
        cuts.insert(0, 0)
    out = []
    for a, b in zip(cuts, cuts[1:]):
        seg = chars[a:b]
        if not seg:
            continue
        out.append({"s": round(seg[0][1], 2), "e": round(seg[-1][2], 2),
                    "z": "".join(c[0] for c in seg)})
    return out


# ── 违规驱动局部重排（默认开）──
# DP 断行后若仍命中行尾/行首禁字，只在该断点**前后各 span 行**的小窗口内重解
# （窗口内禁字升为硬约束、允许 +0/1/2 行），仅当违规数下降才采纳——其余行一个字符都不动。
# 为什么不做全局重解：禁字惩罚 6→12→24 对 4 处缺陷**一处都没改善**，说明瓶颈不是打分
# 而是"每行≤14字"下的可行集不足；全局放宽行数虽能消除局部缺陷，却会引入新的坏断点
# （实测 C0777 反被判出 1 处、并新增「赠|笨」这种新切词），局部重排则零外部副作用。
LOCAL_REPAIR = bool(RULES["caption"].get("localRepair", True))
if (os.environ.get("XUNJIAN_LOCAL_REPAIR") or "").strip().lower() in ("off", "0", "false", "none"):
    LOCAL_REPAIR = False


def _solve_fixed_k(chars, bounds, k, pen, hard):
    """在「恰好 k 行、每行 ≤MAX、≥MIN_LINE、只许在 bounds 处切」下求最优断行。
    bounds / pen 由调用方按**全片**口径算好（局部重排必须与 _break_lines 用同一套词边界与打分，
    否则切片上的 jieba 分词与全片不一致 → 会切出全片层面不是词边界的位置）。
    hard=True 时把「禁字断点」当硬约束（不可行时返回 None，由调用方放宽 k）。"""
    N = len(chars)
    if not N or k < 1:
        return None
    INF = float("inf")
    dp = [INF] * (N + 1); dp[0] = 0.0
    pars = [None] * (k + 1)
    for j in range(1, k + 1):
        ndp = [INF] * (N + 1); npar = [-1] * (N + 1)
        for e in range(1, N + 1):
            best, bp = INF, -1
            for p in range(max(0, e - MAX), e):
                if dp[p] == INF:
                    continue
                if p > 0 and p not in bounds:
                    continue
                if hard and 0 < p < N and pen(p) >= 6.0:
                    continue
                L = e - p
                if L < 1 or (L < MIN_LINE and e != N):
                    continue
                c = dp[p] + (pen(p) if p > 0 else 0.0) + 0.01 * (MAX - L) ** 2
                if c < best:
                    best, bp = c, p
            ndp[e], npar[e] = best, bp
        dp, pars[j] = ndp, npar
    if dp[N] == INF:
        return None
    out, e = [], N
    for j in range(k, 0, -1):
        p = pars[j][e]
        if p < 0:
            return None
        out.append("".join(ch for ch, _, _ in chars[p:e]))
        e = p
        if p == 0:
            break
    out.reverse()
    return out


def _cuts_of(lines):
    c, acc = [0], 0
    for l in lines:
        acc += len(l)
        c.append(acc)
    return c


def _violations(chars, cuts):
    """返回 [(边界序号, 描述, 断点下标)]；边界序号 i 表示 cuts[i]（第 i-1 行与第 i 行之间）。"""
    text = "".join(ch for ch, _, _ in chars)
    out = []
    for i in range(1, len(cuts) - 1):
        p = cuts[i]
        a, b = text[p - 1], text[p]
        jaw, jbw = text[max(0, p - 2):p], text[p:p + 2]
        tail = [w for w in FORBID_END if (a == w or jaw == w or a in FORBID_END_CHARS)]
        head = [w for w in FORBID_START if (b == w or jbw == w or b in FORBID_START_CHARS)]
        if tail:
            out.append((i, "尾禁:" + tail[0], p))
        if head:
            out.append((i, "首禁:" + head[0], p))
    return out


def _local_repair(caps, chars, cut_after, span=1, max_extra=2):
    """对仍命中禁字的断点做小窗口重排（见 LOCAL_REPAIR 说明）。

    关键词：窗口求解必须复用**全片**的词边界与打分函数——切片上重新做 jieba 分词会与全片不一致，
    切出全片层面并非词边界的位置（实测 C0779：「灯光」被切成「灯|光」）。
    """
    N = len(chars)
    if N < 12:
        return caps
    text = "".join(c[0] for c in chars)
    glue = _glue_forbid(text)
    words_list, word_id = [], []
    if WORD_BOUNDARY:
        for wd in jieba.lcut(text):
            words_list.append(wd)
            word_id.extend([len(words_list) - 1] * len(wd))
    else:
        words_list, word_id = list(text), list(range(N))
    gjbound = set()
    if WORD_BOUNDARY:
        i = 0
        for wd in words_list:
            i += len(wd)
            gjbound.add(i)
    else:
        gjbound = set(range(1, N + 1))
    gbounds = (set(cut_after) | gjbound) - glue
    gbounds.add(N)

    def gpen(p):
        if p <= 0 or p >= N:
            return 0.0
        v = 0.0
        lc, rc = text[p - 1], text[p]
        lw, rw = words_list[word_id[p - 1]], words_list[word_id[p]]
        if lw in FORBID_END or lc in FORBID_END_CHARS:
            v += 6.0
        if rw in FORBID_START or rc in FORBID_START_CHARS:
            v += 6.0
        if rw in CLAUSE_START:
            v -= 2.0
        if p in cut_after and p in gjbound:      # 切词型 cut_after 不加分（与 _break_lines 同口径）
            v -= 3.0
        if chars[p][1] - chars[p - 1][2] >= PAUSE_SEC:
            v -= 3.0
        return v

    lines = [c["z"] for c in caps]
    cuts = _cuts_of(lines)
    tried = set()
    changed = 0
    for _ in range(40):
        vs = _violations(chars, cuts)
        if not vs:
            break
        target = next(((i, d, p) for i, d, p in vs if i not in tried), None)
        if target is None:
            break
        i, desc, _p = target
        tried.add(i)
        n = len(lines)
        lo_i = max(0, i - 1 - span)
        hi_i = min(n - 1, i + span)
        if hi_i - lo_i + 1 < 3:
            continue
        lo, hi = cuts[lo_i], cuts[hi_i + 1]
        base_k = hi_i - lo_i + 1
        lb = {p - lo for p in gbounds if lo < p < hi}
        lb.add(hi - lo)
        sub_chars = chars[lo:hi]
        best = None
        for extra in range(0, max_extra + 1):
            sub = _solve_fixed_k(sub_chars, lb, base_k + extra,
                                 (lambda q, _lo=lo: gpen(q + _lo)), True)
            if sub is None:
                continue
            cand = lines[:lo_i] + sub + lines[hi_i + 1:]
            nv = len(_violations(chars, _cuts_of(cand)))
            key = (nv, len(cand))
            if best is None or key < best[0]:
                best = (key, cand, nv)
        if best and best[2] < len(vs):
            lines = best[1]
            cuts = _cuts_of(lines)
            tried.clear()          # 行数变了 → 下标位移，已试记录作废
            changed += 1
            sys.stderr.write("  \u21bb 局部重排 %s (%s) \u2192 缺陷 %d\u2192%d\n" % (
                "".join(ch for ch, _, _ in chars[max(0, _p - 8):_p]) + "|" +
                "".join(ch for ch, _, _ in chars[_p:_p + 8]), desc, len(vs), best[2]))
    if not changed:
        return caps
    out, a = [], 0
    for c in cuts:
        seg = chars[a:c]
        a = c
        if not seg:
            continue
        out.append({"s": round(seg[0][1], 2), "e": round(seg[-1][2], 2),
                    "z": "".join(x[0] for x in seg)})
    return out or caps


def _llm_review(caps, chars, cut_after):
    """断行复核（多选题式）：每个内部断点由代码预生成"合法且不比现状差"的备选切法，
    交 LLM 只做选择题——挑最自然的一项。

    为什么不用"让 LLM 整片重划"：实测小模型会输出大量不合法切点/超长行，整片重划还会
    把原本没问题的断点一起动坏。多选题把 LLM 的职责压缩到"在等价的候选里挑语义最顺的"，
    代码侧同时兜住：合法性、字数、切词、胶合短语、以及"不采纳任何更差的方案"。

    LLM 不可用/超时/解析失败 → 保持 DP 结果，绝不阻断主流程。
    """
    import subprocess
    N = len(chars)
    if N < 12 or len(caps) < 3:
        return caps
    text = "".join(c[0] for c in chars)
    words_list, word_id = [], []
    for wd in (jieba.lcut(text) if WORD_BOUNDARY else list(text)):
        words_list.append(wd)
        word_id.extend([len(words_list) - 1] * len(wd))
    glue = _glue_forbid(text)
    legal = set()
    if WORD_BOUNDARY:
        i = 0
        for wd in words_list:
            i += len(wd)
            legal.add(i)
    legal |= set(cut_after)
    legal = {p for p in legal if 0 < p < N and p not in glue}

    def pen(p):
        """切点 p 的质量代价（与 DP 同源）：越小越像自然断点。"""
        if p <= 0 or p >= N:
            return 0.0
        lw, rw = words_list[word_id[p - 1]], words_list[word_id[p]]
        v = 0.0
        if lw in FORBID_END or text[p - 1] in FORBID_END_CHARS:
            v += 6.0
        if rw in FORBID_START or text[p] in FORBID_START_CHARS:
            v += 6.0
        if rw in CLAUSE_START:
            v -= 2.0
        if p in cut_after:
            v -= 3.0
        if chars[p][1] - chars[p - 1][2] >= PAUSE_SEC:
            v -= 3.0
        return v

    # ── 组装窗口：每个内部切点一个窗口（只保留"当前断点信号弱"的：无停顿、无标点、非分句起头）──
    cuts0, acc = [], 0
    for c in caps:
        acc += len(c["z"])
        cuts0.append(acc)                 # cuts0[k] = 第 k 条边界（内部边界是 cuts0[:-1]）
    wins = []
    pos = 0
    for k in range(len(caps) - 1):
        start = pos                        # 两行合并窗口的绝对起点
        p = cuts0[k]                       # 当前切点的绝对位置
        pos = p
        if p <= 0 or p >= N:
            continue
        if pen(p) < -1.0:
            continue                       # 已有停顿/标点支撑 → 可信，不打扰 LLM
        win = caps[k]["z"] + caps[k + 1]["z"]
        base = len(caps[k]["z"])           # 当前切点在窗口内的相对位置
        m2 = len(win)
        cands = []
        for rel in range(1, m2):
            ap = start + rel
            if ap not in legal:
                continue
            L1, L2 = rel, m2 - rel
            if L1 < MIN_LINE or L2 < MIN_LINE or L1 > MAX or L2 > MAX:
                continue
            cands.append((pen(ap), rel))
        if len(cands) < 2:
            continue
        cands.sort()
        best = cands[0][0]
        sel = [rel for sc, rel in cands if sc <= best + 2.0][:3]
        if base not in sel:
            sel = [base] + sel[:2]
        opts = sorted(set(sel))
        if len(opts) < 2:
            continue
        wins.append({"k": len(wins) + 1, "start": start, "win": win,
                     "cur": base, "opts": opts, "cut": k})
    if not wins:
        sys.stderr.write("ℹ️ 断行复核：无「信号弱」的断点需要复核，跳过\n")
        return caps
    if len(wins) > 40:
        wins = wins[:40]

    # ── 渲染提示词 ──
    blocks = []
    for w in wins:
        win, cur, opts = w["win"], w["cur"], w["opts"]
        s = ["【%d】合并文本：%s" % (w["k"], win)]
        for oi, rel in enumerate(opts):
            s.append("  %s) %s / %s%s" % ("ABCDEFG"[oi], win[:rel], win[rel:],
                                          "   ← 当前" if rel == cur else ""))
        blocks.append("\n".join(s))
    pf = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arbiter-prompt-caption-break.md")
    if not os.path.exists(pf):
        return caps
    with open(pf, encoding="utf-8") as f:
        tmpl = f.read()
    prompt = tmpl.replace("{{WINDOWS}}", "\n\n".join(blocks))

    cmd = os.environ.get("XUNJIAN_CLAUDE")
    if not cmd:
        shim = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ds-claude-shim.mjs")
        if not os.path.exists(shim):
            return caps
        cmd = 'node "%s"' % shim
    env = dict(os.environ)
    env.setdefault("XUNJIAN_DS_MODEL", RULES.get("llm", {}).get("model", "deepseek-flash"))
    try:
        r = subprocess.run(cmd, shell=True, input=prompt, capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=float(RULES.get("llm", {}).get("timeoutMs", 300000)) / 1000.0,
                           env=env)
    except Exception as e:
        sys.stderr.write("⚠️ 断行复核调用失败(%s)，保持 DP 结果\n" % e)
        return caps
    out = r.stdout or ""
    dump = os.environ.get("XUNJIAN_BREAK_DUMP")
    if dump:
        try:
            with open(dump, "w", encoding="utf-8") as f:
                f.write(prompt + "\n\n===OUT===\n" + out)
        except Exception:
            pass
    try:
        obj = json.loads(out[out.index("{"): out.rindex("}") + 1])
        picks = obj.get("picks") or {}
    except Exception:
        sys.stderr.write("⚠️ 断行复核结果不可解析，保持 DP 结果\n")
        return caps

    # ── 代码裁决：按切点下标回填（每条边界只属于一个窗口，天然不冲突）──
    cuts = list(cuts0)
    changed = 0
    for w in wins:
        ch = str(picks.get(str(w["k"]), "")).strip().upper()
        if not ch or ch == "0" or ch not in "ABCDEFG"[:len(w["opts"])]:
            continue
        rel = w["opts"]["ABCDEFG".index(ch)]
        if rel == w["cur"]:
            continue
        cuts[w["cut"]] = w["start"] + rel
        changed += 1
    if not changed:
        sys.stderr.write("ℹ️ 断行复核：LLM 认为当前断行已是最自然，无改动\n")
        return caps
    # 复核合法性（回填后仍要满足行长/单调）
    prev, ok = 0, True
    for c in cuts:
        L = c - prev
        if L < 1 or L > MAX or (L < MIN_LINE and c != N):
            ok = False
            break
        prev = c
    if not ok or cuts[-1] != N or any(cuts[i] >= cuts[i + 1] for i in range(len(cuts) - 1)):
        sys.stderr.write("⚠️ 断行复核改动后行长越界，回退 DP 结果\n")
        return caps
    rebuilt, a = [], 0
    for c in cuts:
        seg = chars[a:c]
        a = c
        if not seg:
            continue
        rebuilt.append({"s": round(seg[0][1], 2), "e": round(seg[-1][2], 2),
                        "z": "".join(x[0] for x in seg)})
    sys.stderr.write("✓ 断行复核采纳：%d/%d 处断点被改写\n" % (changed, len(wins)))
    return rebuilt or caps


def _repair_overlong(caps):
    """订正词典会加长字串(如「技效率→记忆效率」),可能把已断好的行撑过 MAX 字。
    这里对超长行**复用同一套 DP** 重切(合成等分时间戳,无词级停顿信号)——
    比贪心切更稳,且不会切出碎行。"""
    out = []
    for c in caps:
        t = c["z"]
        if len(t) <= MAX:
            out.append(c)
            continue
        L, s, e = len(t), c["s"], c["e"]
        chars = [(t[i], s + (e - s) * i / L, s + (e - s) * (i + 1) / L) for i in range(L)]
        out.extend(_break_lines(chars, set()))
    return out


# 拆行时不允许落在这类字之后（"…跟爸爸的｜关系"读着就断，属行尾禁字）
# 纯附着词：不能出现在行首（"…爸爸｜的关系"是坏断行），故不能作为"干净边界"的下一词
_ATTACH = set("的了着过吗呢吧啊呀嘛")

_FUNC_WORDS = set("不和的与跟了着过把被让给对在是就也还又再而但其以之将要会能有没很太更最该应")

_BAD_END = set("的了着过着得地吗呢吧啊呀嘛们和与跟把被对在是就都也而但其之以向于将够")


def _split_text_lines(text, n, phrase_bounds=None):
    """把一句(n 行)在**语义边界**上均分。

    切点优先级：
      ① **短语空格边界**（`phrase_bounds`）——whisper 的句段文本用空格分隔短语，
         实测「我觉得一个家庭里面 最该成长的首先是爸爸」，空格位置正是说话人的换气点，
         比 jieba 词边界更贴合语义（按 jieba 会切成「我觉得一个家庭｜里面最该成长的…」，读着断）；
      ② jieba 词边界，且要求边界两侧都是 ≥2 字的词（避免「乐观心里｜面特别积极」这种
         词典未收录词被劈开的情况）；
      ③ 任意字符边界（兜底）。
    """
    L = len(text)
    if n <= 1 or L <= n:
        return [text]
    # ① 短语边界：只在两行、且切点接近均分位置时采用（否则两行长短悬殊，观感更差）
    if phrase_bounds and n == 2:
        # 短语空格虽然常是换气点，但 whisper 也会在虚词前后切（实测「一个情绪平｜和不计不造」、
        # 「…能够｜安安静静」）——这类切点必须排除，交给 jieba 重新决定。
        ok = [b for b in phrase_bounds
              if MIN_LINE <= b <= L - MIN_LINE
              and abs(b - L / 2.0) <= L * 0.28
              and text[b] not in _CONT_START
              and text[b - 1] not in _BAD_END]
        if ok:
            cut = min(ok, key=lambda b: abs(b - L / 2.0))
            return [text[:cut], text[cut:]]
    cand = []                                   # [(pos, clean)]
    if WORD_BOUNDARY:
        try:
            import jieba
            words = list(jieba.cut(text, HMM=False))
            # "V不V"（能不能/是不是/好不好）内部不许切：jieba 会把它切成「能｜不能」，
            # 那样会断出「孩子将来能」「不能出色…」两卡。
            vbu = set()
            for m in re.finditer(r"([\u4e00-\u9fff])不\1", text):
                vbu.add(m.start() + 1)
                vbu.add(m.start() + 2)
            pos = 0
            for wi, wd in enumerate(words):
                pos += len(wd)
                if 0 < pos < L:
                    prev_len = len(words[wi - 1]) if wi > 0 else 99
                    next_len = len(words[wi + 1]) if wi + 1 < len(words) else 99
                    # next 是 1 字虚词（"平和｜不…"）也算干净边界；
                    # 但 next 是 1 字实词（"心里｜面"）就不可靠——那多半是 jieba 词典缺词。
                    ok = (prev_len >= 1 and (next_len >= 2 or (words[wi + 1] in _FUNC_WORDS and words[wi + 1] not in _ATTACH))
                          and text[pos - 1] not in _BAD_END
                          and pos not in vbu)
                    cand.append((pos, ok))
        except Exception:
            cand = []
    if not cand:
        cand = [(i, True) for i in range(1, L)]
    clean = [p for p, ok in cand if ok]
    pool = clean or [p for p, _ in cand]
    cuts, prev = [], 0
    for k in range(1, n):
        tgt = L * k / float(n)
        # 还要保证每行至少 2 字，避免"单字成行"
        usable = [b for b in pool if b > prev + 1 and (L - b) >= (n - k) * 2]
        if not usable:
            usable = [b for b in pool if b > prev]
        if not usable:
            usable = list(range(prev + 1, L))
        cut = min(usable, key=lambda b: abs(b - tgt))
        cuts.append(cut)
        prev = cut
    parts, last = [], 0
    for c in cuts + [L]:
        if c > last:
            parts.append(text[last:c]); last = c
    return parts or [text]


# 句子合并：前段以这些字收尾说明"话没说完"，应把后段并回来当一句。
# 只收**必须带后续成分**的词——请勿加入 的/了/吗/呢/吧 等（它们是正常句尾，
# 实测「…最该成长的」|「首先是爸爸」是合法断点，加进去会强行粘连）。
_CONT_END = set("能会要想说把被让给对跟和与在是有像比从向为很太更最不没将就也还又再该应需够")
# 句子合并：后段以这些字开头说明是**续接**而非新句（"的带子"、"让难题…"）。
# 只收纯虚词/介词——"不/其/而/也/就/都/是"一律不收（"不只是…""其次…"都是正常新句开头，
# 实测加进去会把「爸爸在家里的角色」和「不只是挣钱那个人」粘成一句）。
_CONT_START = set("的了吗呢着过把被让给对和与跟要")


def _merge_wordcut(segs, samples=None, sr=16000):
    """把「VAD 边界其实不是句界」的相邻句段合并回一句。

    背景：v4/v5 的字幕结构是「卡 = 一个 VAD 句段」。但 whisper 的 VAD 切点是**声学**的，
    且词/段的时间戳把停顿吸收进了时长（实测词间空隙≈0），于是出现两类硬伤：
      · 把一个词劈开：「养出来是乐观心里」|「面特别积极的孩子」（"心里面"）
      · 把一个短语劈开：「孩子将来能」|「不能出色跟爸爸的关系」（"能不能"）
    判据（两道，满足其一即合并）：
      ① **音频无停顿**：在边界 ±0.35s 内找不到 ≥0.10s 的静音 → 说话人根本没停，不是句界；
      ② jieba 词内切断：前后拼接后边界落在某个词内部（无音频时的兜底，也补①的漏）。
    合并后总长超过 2 行时不再合并，交给拆行逻辑处理。
    """
    if not segs:
        return segs
    mask = win = None
    if samples is not None:
        try:
            import numpy as np
            win = 0.02
            n = max(1, int(win * sr))
            m = len(samples) // n
            if m > 8:
                fr = np.asarray(samples[:m * n], dtype="float32").reshape(m, n)
                rms = np.sqrt((fr ** 2).mean(axis=1))
                mask = rms > COV_RMS
        except Exception:
            mask = None

    # 强句界：≥0.30s 的停顿视为说话人真的换了句（实测真句界「成长的｜首先是爸爸」0.22s、
    # 被切开的短语 0.14s，两者太近；故这里只把"明显长停顿"当硬保护，语义判断交给下面两条）。
    MERGE_PAUSE = float(RULES.get("caption", {}).get("mergePauseSec", 0.30))

    def has_pause(t0, t1):
        if mask is None or win is None:
            return True                       # 无音频信息 → 不敢合并
        a, b = max(0, int(t0 / win)), min(len(mask), int(t1 / win))
        best = cur = 0
        for v in mask[a:b]:
            cur = 0 if v else cur + 1
            if cur > best:
                best = cur
        return best * win >= MERGE_PAUSE

    def wordcut(at, bt):
        try:
            import jieba
        except Exception:
            return False
        tail, head = at[-6:], bt[:6]
        pos, idx = len(tail), 0
        for wd in jieba.cut(tail + head, HMM=False):
            if idx < pos < idx + len(wd):
                return True
            idx += len(wd)
        return False

    out = [segs[0]]
    for s in segs[1:]:
        prev = out[-1]
        at = _NON_TXT.sub("", prev.text or "")
        bt = _NON_TXT.sub("", s.text or "")
        if not at or not bt or len(at) + len(bt) > MAX * 2:
            out.append(s)
            continue
        # 强续接信号（语法上必须接下去）——无视停顿，直接合并：
        #   前段以助动词/介词收尾（"能够｜安安静静"）、后段以纯虚词开头（"一个情绪平｜和不计不造"）
        strong = at[-1] in _CONT_END or bt[0] in _CONT_START
        if not strong and has_pause(prev.end - 0.35, s.start + 0.35):
            if os.environ.get("XUNJIAN_MERGE_DEBUG"):
                sys.stderr.write("· 不合并(停顿) %r | %r end=%.2f start=%.2f\n"
                                 % (at[-8:], bt[:8], prev.end, s.start))
            out.append(s)
            continue
        # 无强信号时：只有前段是残片（≤3 字）才合并
        if not strong and len(at) > 3:
            if os.environ.get("XUNJIAN_MERGE_DEBUG"):
                sys.stderr.write("· 不合并(无延续) %r | %r\n" % (at[-8:], bt[:8]))
            out.append(s)
            continue
        # 合并后**不加空格**：那个边界正是被判定为"不是真句界"的位置，
        # 若保留空格，拆行时会把它当短语边界又切回原处（实测「孩子将来能｜不能出色…」）。
        # 去掉后由 jieba 词边界重新决定切点。
        out[-1] = _Seg(prev.start, s.end, (prev.text or "").strip() + (s.text or "").strip(),
                       list(prev.words or []) + list(s.words or []))
    return out


def _build_sentence_caps(segs, clean):
    """v4 版式：**卡 = 一个 whisper VAD 句段**（≈逗号级小句）。
    - 卡时长 = 该句音频时长（[s,e]），与画面天然对齐；
    - 句段 ≤MAX 字 → 一卡；>MAX 字 → 同句内拆 2 行（>2*MAX 才 3 行），**按字数比例分配时间**，
      于是两行"依次出现"，且每行都落在它正被念到的那段时间上。
    一条不跨卡、两条不并卡：由"卡=句段"从结构上保证。
    """
    out = []
    for s in segs:
        # 按空格切短语：空格位置 = 说话人的换气点，是拆行的首选边界（见 _split_text_lines）
        phrases = [p for p in (clean(x) for x in re.split(r"\s+", s.text or "")) if p]
        joined = "".join(phrases)
        whole = clean(s.text)
        if not whole:
            continue
        pb, acc = set(), 0
        for p in phrases[:-1]:
            acc += len(p)
            if 0 < acc < len(joined):
                pb.add(acc)
        # 订正词典里有跨空格条目（如 "A I"→"AI"）时，短语切分会失配 → 退回整串结果
        text, pb = (joined, pb) if joined == whole else (whole, set())
        L = len(text)
        start, end = float(s.start), float(s.end)
        if end <= start:
            end = start + 0.30 * L              # 兜底：无有效时长的极端情况
        n = 1 if L <= MAX else (2 if L <= 2 * MAX else (L + MAX - 1) // MAX)
        parts = [text] if n <= 1 else _split_text_lines(text, n, pb)
        tot = float(sum(len(p) for p in parts)) or 1.0
        acc = 0
        for p in parts:
            a = start + (end - start) * acc / tot
            acc += len(p)
            b = start + (end - start) * acc / tot
            out.append({"s": round(a, 2), "e": round(b, 2), "z": p})
    return out


# 繁转简：只做一次，之后 raw_segs / 字幕 / 词级检测统一走简体
if T2S_ON and segs:
    segs = _t2s_segs(segs)

caps = []
raw_segs = []
all_words = []  # 全片词序列，仅供 XUNJIAN_DUMP_WORDS 调试导出
for s in segs:
    words = s.words or []
    # w = 词级时间戳 [[start, end, word], ...]，供重说/卡壳检测判断词时长异常
    raw_segs.append({"s": round(s.start, 2), "e": round(s.end, 2), "z": s.text.strip(),
                     "w": [[round(w.start, 2), round(w.end, 2), w.word.strip()] for w in words]})
    all_words.extend(words)


def _clean_text(text):
    for bad, good in FIXES:
        text = text.replace(bad, good)
    return _NON_TXT.sub("", text)               # 去标点/空白，保持逐字字幕的紧凑观感


if CAP_LAYOUT == "pack":
    # 旧版：全片拼字 + 跨句 DP 装箱（会"一句跨卡/两句并卡"，留作回滚）
    g_chars, g_cut_after = [], set()
    for s in segs:
        words = s.words or []
        if not words:
            txt = PUNCT_RE.sub("", s.text)
            for ch in txt:
                g_chars.append((ch, s.start, s.end))
            if txt:
                g_cut_after.add(len(g_chars))
            continue
        for w in words:
            t = w.word
            clean = PUNCT_RE.sub("", t)
            for ch in clean:
                g_chars.append((ch, w.start, w.end))
            if clean and PUNCT_RE.search(t):
                g_cut_after.add(len(g_chars))
        g_cut_after.add(len(g_chars))
    if g_chars:
        caps = _break_lines(g_chars, g_cut_after)
        if caps and LOCAL_REPAIR:
            _n1 = len(caps)
            caps = _local_repair(caps, g_chars, g_cut_after)
            if len(caps) != _n1:
                print("BREAK_LOCAL lines=%d→%d" % (_n1, len(caps)))
        if caps and BREAK_LLM:
            _n0 = len(caps)
            caps = _llm_review(caps, g_chars, g_cut_after)
            print("BREAK_LLM lines=%d→%d" % (_n0, len(caps)))
    for c in caps:
        c["z"] = _clean_text(c["z"])
    caps = [c for c in caps if c["z"]]
    caps = _repair_overlong(caps)               # 订正词典可能撑长行 → 再断一次，保证 ≤ MAX
else:
    _m0 = len(segs)
    _smp, _sr = (None, 16000)
    try:
        _smp, _sr = _read_wav_mono16k(audio)
    except Exception as _e:
        sys.stderr.write("ℹ️ 读不到音频，句子合并只按词边界判断(%s)\n" % _e)
    segs = _merge_wordcut(segs, _smp, _sr)
    if len(segs) != _m0:
        print("CAP_MERGE 词内切断合并 %d→%d 句" % (_m0, len(segs)))
    caps = _build_sentence_caps(segs, _clean_text)
    _mv = sum(1 for c in caps if len(c["z"]) > MAX)
    print("CAP_LAYOUT=sentence lines=%d 超长=%d" % (len(caps), _mv))

# Windows 下 open() 默认按本地编码(GBK/cp936)写盘，会把中文字幕写成乱码；
# 这里统一以 UTF-8 写出，与 run.mjs 的 readFileSync(..., "utf8") 对齐。
def dump_json(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)

dump_json(caps, out)
if segs_out:
    dump_json(raw_segs, segs_out)
# 调试用:把原始句段(含词级时间戳)另存一份(与 segs_out 同格式),
# 用于离线快速迭代断行算法(不必每次重跑 whisper)。
if os.environ.get("XUNJIAN_DUMP_SEGWORDS"):
    dump_json(raw_segs, os.environ["XUNJIAN_DUMP_SEGWORDS"])
# 调试用:导出全片词级时间戳(XUNJIAN_DUMP_WORDS=路径),用于排查漏检的重说
if os.environ.get("XUNJIAN_DUMP_WORDS"):
    dump_json([{"s": round(w.start, 2), "e": round(w.end, 2), "w": w.word} for w in all_words],
              os.environ["XUNJIAN_DUMP_WORDS"])
print(f"ASR_DONE lines={len(caps)} segs={len(raw_segs)} dur={caps[-1]['e'] if caps else 0}")
