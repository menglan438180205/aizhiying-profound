'use strict';
/* =========================================================
   renderer.js — 真实视频合成引擎（FFmpeg）
   管线：素材 → 逐镜头（缩放裁切 / 运镜 / 去重 / 淡入淡出 / 字幕）
              → concat 拼接 → 音轨封装 → 封面抽帧 → 成片
   - 每个成片只做一次视频编码 + 一次 -c:v copy 封装，速度优先
   - 逐镜头回调进度，前端可实时看到成片逐条产出
   ========================================================= */

const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const ec = require('./edit-capabilities');

const FPS = 25;

const RATIO_CANVAS = {
  '9:16': { w: 720, h: 1280 },
  '16:9': { w: 1280, h: 720 },
  '1:1': { w: 960, h: 960 },
  '4:5': { w: 864, h: 1080 }
};

/* =========================================================
   字体选择
   ---------------------------------------------------------
   drawtext 需要带中文字形的字体，否则中文标题会渲染成方块（豆腐）。
   Windows 默认 simhei、macOS 默认 PingFang 都自带中文；
   Linux 必须显式安装 fonts-noto-cjk（Debian/Ubuntu）或
   wqy-zenhei（Alpine），镜像里已经带上，见 Dockerfile。
   ========================================================= */

const WIN_FONT = 'C:/Windows/Fonts/simhei.ttf';
const MAC_FONTS = [
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/Library/Fonts/Arial Unicode.ttf'
];
/* Linux 上按「含中文字形」优先排序；DejaVu 放最后仅作兜底（无 CJK） */
const LINUX_CJK_FONTS = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf'
];
const LINUX_FALLBACK_FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];

/* 含中文字形的字体名特征（用于判定字幕是否会变方块） */
const CJK_HINT = /noto|source\s*han|pingfang|heiti|simhei|simsun|msyh|yahei|wqy|wenquanyi|uming|ukai|droidsansfallback|cjk|unicode/i;

function fontCandidates(envFont) {
  const platform = process.platform;
  const mid = platform === 'win32' ? [WIN_FONT]
    : platform === 'darwin' ? MAC_FONTS
      : LINUX_CJK_FONTS;
  const tail = platform === 'win32' ? [] : LINUX_FALLBACK_FONTS;
  return [envFont, process.env.RENDER_FONT, process.env.FFMPEG_FONT]
    .concat(mid, tail).filter(Boolean);
}

function pickFont(envFont) {
  for (const c of fontCandidates(envFont)) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return '';
}

/**
 * 字体状态：给启动横幅 / health / preflight 用。
 * cjk=false 表示找到了字体但没有中文字形 —— 成片里的中文会变方块。
 */
function fontStatus(envFont) {
  const p = pickFont(envFont);
  if (!p) return { ok: false, cjk: false, path: '', candidates: fontCandidates(envFont).length, message: '未找到可用字体，字幕将被跳过' };
  return {
    ok: true,
    cjk: CJK_HINT.test(p),
    path: p,
    source: (envFont || process.env.RENDER_FONT || process.env.FFMPEG_FONT) === p ? 'env' : 'auto',
    candidates: fontCandidates(envFont).length,
    message: CJK_HINT.test(p) ? '含中文字形' : '缺少中文字形，中文会渲染为方块'
  };
}

function canvasOf(ratio) { return RATIO_CANVAS[ratio] || RATIO_CANVAS['9:16']; }

function even(n) { const v = Math.round(n); return v % 2 === 0 ? v : v + 1; }

/** 缩放到画布所需的基础 scale/crop（图片与视频共用同一套口径） */
function baseFilters(W, H, motion, factor) {
  if (motion === 'none') {
    return [`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`];
  }
  const k = factor || 2;
  return [`scale=${even(W * k)}:${even(H * k)}:force_original_aspect_ratio=increase`,
    `crop=${even(W * k)}:${even(H * k)}`];
}

/** 生成单个镜头的 filter 链；baseDone=true 表示 scale/crop 已由调用方前置 */
function shotFilter(opts, baseDone) {
  const { motion, transition, W, H, dur, titleText, ctaText, font } = opts;
  const parts = [];
  if (!baseDone) parts.push.apply(parts, baseFilters(W, H, motion));

  if (motion !== 'none') {
    const frames = Math.max(1, Math.round(FPS * dur));
    let z, x, y;
    if (motion === 'pan') {
      z = '1.18';
      x = `(iw-iw/zoom)*(on/${frames})`;
      y = 'ih/2-(ih/zoom/2)';
    } else {
      const target = motion === 'zoom' ? 1.45 : 1.28;
      const rate = (target - 1) / frames;
      z = `min(1+${rate.toFixed(6)}*on,${target})`;
      x = 'iw/2-(iw/zoom/2)';
      y = 'ih/2-(ih/zoom/2)';
    }
    parts.push(`zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${FPS}`);
  }
  parts.push('fps=' + FPS);
  parts.push('setsar=1');

  if (transition === 'fade' || transition === 'slide' || transition === 'smart') {
    const d = Math.min(0.4, Math.max(0.2, dur / 6)).toFixed(2);
    const outStart = Math.max(0, dur - Number(d)).toFixed(2);
    parts.push(`fade=t=in:st=0:d=${d}`);
    parts.push(`fade=t=out:st=${outStart}:d=${d}`);
  }

  if (font) {
    const ff2 = font.replace(/\\/g, '/').replace(':', '\\:');
    if (titleText) {
      parts.push(`drawtext=fontfile='${ff2}':textfile='title.txt':fontcolor=white:fontsize=${Math.round(W / 22)}`
        + `:x=(w-text_w)/2:y=${Math.round(H / 20)}:box=1:boxcolor=black@0.42:boxborderw=${Math.round(W / 48)}`);
    }
    if (ctaText) {
      parts.push(`drawtext=fontfile='${ff2}':textfile='cta.txt':fontcolor=white:fontsize=${Math.round(W / 28)}`
        + `:x=(w-text_w)/2:y=h-${Math.round(H / 10)}:box=1:boxcolor=0xE0403A@0.85:boxborderw=${Math.round(W / 56)}`);
    }
  }
  return parts.join(',');
}

/** 切分一个视频素材（去重策略：错位取样 + 轻微变速 + 镜像翻转） */
function videoShotArgs(asset, out, o) {
  const { dur, dedupe, mirror, speed } = o;
  const args = [];
  const srcDur = Number(asset.duration) || 0;
  // 错位起点：按成片序号错开，避免同素材每片都用同一段
  let ss = 0;
  if (srcDur > dur + 1) {
    const span = Math.max(0, srcDur - dur);
    ss = Number(((o.index * 0.37) % 1 * span).toFixed(2));
  }
  if (ss > 0) args.push('-ss', String(ss));
  args.push('-i', asset.rel);
  /* 基础 scale/crop 由这里负责（视频要先做去重变换，再交给 zoompan），
     shotFilter 只产出运镜/帧率/转场/字幕，避免同一段滤镜生成两次再字符串剔除。 */
  const vf = baseFilters(o.W, o.H, o.motion, 1.3);
  if (dedupe && mirror) vf.push('hflip');
  if (dedupe && speed && speed !== 1) vf.push(`setpts=PTS/${speed}`);
  const chain = vf.concat(shotFilter(o, true).split(',')).join(',');
  // -t 放在输出侧：变速后仍保证每镜头时长一致
  args.push('-an', '-vf', chain, '-t', String(dur),
    '-c:v', 'libx264', '-preset', o.preset || 'veryfast',
    '-crf', String(o.crf || 26), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', out);
  return args;
}

/** 图片素材 → 运镜镜头 */
function imageShotArgs(asset, out, o) {
  const chain = shotFilter(o);
  return ['-loop', '1', '-framerate', String(FPS), '-t', String(o.dur), '-i', asset.rel,
    '-vf', chain, '-c:v', 'libx264', '-preset', o.preset || 'veryfast',
    '-crf', String(o.crf || 26), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', out];
}

/* ------------------------------------------------------------------
   主入口
   ------------------------------------------------------------------ */

/**
 * @param {object} job  { id, title, request:{count,ratio,shotSeconds,motion,transition,dedupe,voice,coverTitle,cta}, assets:[asset] }
 * @param {object} ctx  { dir, outDir, onProgress(done,total,stage), signal, log(level,msg) }
 * @returns {Promise<Array>} outputs
 */
async function renderJob(job, ctx) {
  const cfg = job.request || {};
  const assets = (job.assets || []).filter((a) => a && a.rel && fs.existsSync(path.join(ctx.dir, a.rel)));
  if (!assets.length) throw Object.assign(new Error('没有可用的素材文件'), { code: 'NO_ASSET' });

  const ratio = cfg.ratio || '9:16';
  const { w: W, h: H } = canvasOf(ratio);
  const count = Math.max(1, Math.min(Number(cfg.count) || 1, Number(process.env.RENDER_MAX_OUTPUTS || 20)));
  const shotSeconds = Math.max(1, Math.min(Number(cfg.shotSeconds) || 2.5, 8));
  const motion = cfg.motion || 'kenburns';
  const transition = cfg.transition || 'cut';
  const dedupe = cfg.dedupe !== false;
  const font = pickFont();
  const preset = process.env.RENDER_PRESET || 'veryfast';
  const crf = Number(process.env.RENDER_CRF || 26);

  /* ---- 本地能力插件开关：配音与字幕（缺则如实降级，不阻断渲染） ---- */
  const wantVoice = cfg.voice === true || cfg.voice === 'true';
  const wantSub = wantVoice && cfg.subtitle !== false && cfg.subtitle !== 'false';
  const voiceRate = Math.max(0.5, Math.min(Number(cfg.voiceRate) || Number(process.env.EDIT_TTS_RATE) || ec.DEFAULT_RATE, 3.0));
  const voiceText = String(cfg.voiceText || '').trim()
    || (String(job.title || '') + '。' + String(cfg.ctaText || '评论区扣 1 拿批发价 · 源头厂家'));
  const media = {
    voice: { ok: false, channel: 'none', reason: wantVoice ? '' : '未开启' },
    subtitle: { ok: false, mode: 'none', reason: wantVoice ? '' : '未开启' }
  };
  let narration = null;
  let subSegments = [];

  // 每条成片的镜头数：素材足够时取 4~6 段，保证每条成片有差异
  const shotsPerOutput = Math.max(2, Math.min(assets.length, Number(cfg.shotsPerOutput) || 5));
  const totalUnits = count * (shotsPerOutput + 1) + (wantVoice ? 1 : 0);
  let doneUnits = 0;
  const tick = (stage) => {
    doneUnits++;
    if (typeof ctx.onProgress === 'function') {
      try { ctx.onProgress(doneUnits, totalUnits, stage); } catch (e) {}
    }
  };
  const log = ctx.log || function () {};

  // 字幕文本落盘（用 textfile 规避中文与特殊字符转义）
  const titlePath = path.join(ctx.dir, 'title.txt');
  const ctaPath = path.join(ctx.dir, 'cta.txt');
  const showTitle = cfg.coverTitle !== false;
  const showCta = cfg.cta !== false;
  fs.writeFileSync(titlePath, showTitle ? String(job.title || '').slice(0, 40) : '', 'utf8');
  fs.writeFileSync(ctaPath, showCta ? String(cfg.ctaText || '评论区扣 1 拿批发价 · 源头厂家') : '', 'utf8');

  const outputs = [];
  log('info', `渲染参数：${ratio} ${W}x${H} · 每条 ${shotsPerOutput} 镜 × ${shotSeconds}s · 运镜 ${motion} · 转场 ${transition} · 共 ${count} 条`);

  /* ---- 配音：逐句本地合成，真实时长即字幕时间轴（不需要语音识别） ---- */
  if (wantVoice) {
    if (typeof ctx.onStage === 'function') { try { ctx.onStage('正在生成配音'); } catch (e) {} }
    const rv = await ec.tts.build(ec.subtitle.split(voiceText), ctx.dir, { rate: voiceRate, signal: ctx.signal });
    if (rv.ok) {
      narration = rv;
      subSegments = rv.segments;
      media.voice = {
        ok: true, channel: 'system-tts', provider: rv.provider, voice: rv.voice,
        rate: rv.rate, duration: rv.duration, sentences: rv.segments.length
      };
      log('ok', `配音已生成：${rv.segments.length} 句 · ${rv.duration}s · 语速 ${rv.rate}× · 语音 ${rv.voice || '默认'}（${rv.provider}）`);
    } else {
      media.voice = { ok: false, channel: 'none', reason: rv.message || rv.code };
      log('warn', `配音未生成（${rv.message || rv.code}）· 本单输出无配音成片，界面会如实标注`);
    }
    tick('配音处理完成');
  }

  if (wantSub && narration) {
    const caps0 = await ff.capabilities().catch(() => null);
    const libass = !!(caps0 && caps0.subtitles) && !!font;
    media.subtitle = {
      ok: !!font,
      mode: libass ? 'libass' : (font ? 'drawtext' : 'none'),
      reason: libass ? '' : (font ? '无 libass，降级 drawtext 逐条烧录' : '未找到中文字体，跳过字幕')
    };
    log('info', `字幕计划：${narration.segments.length} 句 · 用 ${media.subtitle.mode} 烧录`);
  }
  // 所有 ffmpeg 调用统一以 job 目录为 cwd，传相对路径；避免 Windows 盘符冒号转义
  const relOf = (p) => path.relative(ctx.dir, p).split(path.sep).join('/');

  for (let i = 0; i < count; i++) {
    if (ctx.signal && ctx.signal.aborted) throw Object.assign(new Error('已取消'), { code: 'CANCELED' });
    const sd = 'shots_' + i;                       // 相对 job 目录
    fs.mkdirSync(path.join(ctx.dir, sd), { recursive: true });

    // 轮转取素材，保证每条成片镜头顺序不同
    const picks = [];
    for (let k = 0; k < shotsPerOutput; k++) picks.push(assets[(i + k) % assets.length]);

    const shotFiles = [];
    let bodyDur = 0;
    for (let k = 0; k < picks.length; k++) {
      const a = picks[k];
      const sf = `${sd}/s${k}.mp4`;
      const common = {
        index: i * shotsPerOutput + k, W, H, dur: shotSeconds, motion, transition, font,
        titleText: showTitle, ctaText: showCta, dedupe, preset, crf,
        mirror: dedupe && (i + k) % 2 === 1,
        speed: dedupe ? (k % 3 === 0 ? 1.04 : (k % 3 === 1 ? 1 : 0.97)) : 1
      };
      // 视频素材时长不足时缩短镜头
      let dur = shotSeconds;
      if (a.kind === 'video' && a.duration && a.duration < shotSeconds) {
        dur = Math.max(1, Number(a.duration.toFixed(1)));
      }
      common.dur = dur;
      bodyDur += dur;
      const args = a.kind === 'image'
        ? imageShotArgs(a, sf, common)
        : videoShotArgs(a, sf, common);
      const r = await ff.run(args.concat(['-progress', 'pipe:1', '-nostats']), { cwd: ctx.dir, signal: ctx.signal });
      if (r.code !== 0) throw new Error(`镜头渲染失败（${a.name}）：${(r.stderr || '').split('\n').slice(-4).join(' ').slice(0, 300)}`);
      shotFiles.push(`s${k}.mp4`);
      log('plain', `成片 ${i + 1}/${count} · 镜头 ${k + 1}/${picks.length} 完成（${a.name}）`);
      tick(`渲染成片 ${i + 1}/${count} · 镜头 ${k + 1}/${picks.length}`);
    }

    // 拼接（无损 stream copy）——list.txt 内的相对路径按列表文件所在目录解析
    fs.writeFileSync(path.join(ctx.dir, sd, 'list.txt'),
      shotFiles.map((f) => `file '${f}'`).join('\n') + '\n', 'utf8');
    const rc = await ff.run(['-f', 'concat', '-safe', '0', '-i', `${sd}/list.txt`, '-c', 'copy', '-y', `${sd}/body.mp4`],
      { cwd: ctx.dir, signal: ctx.signal });
    if (rc.code !== 0) throw new Error('拼接失败：' + (rc.stderr || '').slice(-200));

    // 字幕：烧在 body 上。这一步会多一次编码，仅在开启字幕时发生。
    // 字幕按本条成片的真实时长裁剪（maxEnd），与配音的 atrim 行为保持一致。
    let videoRel = `${sd}/body.mp4`;
    let usedSub = 'none';
    if (wantSub && narration && subSegments.length) {
      const rsub = await burnSubtitles({
        srcRel: videoRel, dstRel: `${sd}/subbed.mp4`,
        srtText: ec.subtitle.toSrt(subSegments, { maxEnd: Number(bodyDur.toFixed(3)) }),
        items: subSegments, srtRel: `${sd}/subs.srt`, workDir: ctx.dir,
        font, W, H, preset, crf, signal: ctx.signal,
        log: (lv, m) => log(lv, m)
      });
      if (rsub.ok) {
        videoRel = `${sd}/subbed.mp4`;
        usedSub = rsub.mode;
        media.subtitle = { ok: true, mode: rsub.mode, reason: rsub.mode === 'libass' ? '' : '降级为 drawtext 逐条烧录' };
      } else {
        /* 字幕烧录失败：如实标记失败，而不是留着 ok:true。
           前端据此提示「本条无字幕」，避免交付一条用户以为有字幕的成片。 */
        log('warn', '字幕烧录失败，本条输出无字幕：' + (rsub.reason || ''));
        media.subtitle = { ok: false, mode: 'none', reason: rsub.reason || '字幕烧录失败' };
      }
    }

    // 音轨封装（视频流 copy，不动画质；配音与背景乐在此混音）
    const outName = `${job.id}_${String(i + 1).padStart(2, '0')}.mp4`;
    const finalPath = path.join(ctx.outDir, outName);
    const staged = `${sd}/out.mp4`;
    const bgm = findBgm(ctx.bgmDir);
    const muxArgs = buildMuxArgs(videoRel, staged, bgm, cfg, narration, bodyDur);
    const rm = await ff.run(muxArgs, { cwd: ctx.dir, signal: ctx.signal });
    let hasAudio = true;
    if (rm.code !== 0) {
      /* 音轨失败则降级为无音轨成片，不整体失败。
         ⚠️ 原实现这里固定复制 body.mp4 —— 但 body.mp4 是**未烧字幕**的中间体，
         字幕是在 videoRel（subbed）上烧的。降级时复制 body 会把已经烧好的字幕丢掉，
         用户拿到的成片「无声且无字幕」，而任务状态仍是成功。
         修正：优先复制已烧字幕的 subbed，其次才是 body。 */
      log('warn', '音轨封装失败，降级为无音轨成片：' + (rm.stderr || '').slice(-160));
      hasAudio = false;
      const subbedFallback = path.join(ctx.dir, sd, 'subbed.mp4');
      const bodyFallback = path.join(ctx.dir, sd, 'body.mp4');
      const pick = fs.existsSync(subbedFallback) ? subbedFallback : bodyFallback;
      fs.copyFileSync(pick, finalPath);
    } else {
      fs.copyFileSync(path.join(ctx.dir, staged.replace(/\//g, path.sep)), finalPath);
    }

    // 封面抽帧
    const coverName = `${job.id}_${String(i + 1).padStart(2, '0')}.jpg`;
    const coverPath = path.join(ctx.outDir, coverName);
    const rcov = await ff.run(['-ss', '0.4', '-i', relOf(finalPath), '-frames:v', '1', '-q:v', '3', '-y', relOf(coverPath)],
      { cwd: ctx.dir });
    const coverOk = rcov.code === 0 && fs.existsSync(coverPath);

    const meta = await ff.probe(finalPath);
    const stat = fs.statSync(finalPath);

    /* 产物校验：以前 probe 失败就用估算宽高/时长顶上，0 字节的半成品也算「成功」。
       销售拿到的是「成片」链接，但点开是坏文件 —— 必须在交付前拦住。
       阈值：1KB 以下的 mp4 一定是坏的（连 moov 都装不下）。 */
    const MIN_OUTPUT_BYTES = 1024;
    if (!stat || stat.size < MIN_OUTPUT_BYTES) {
      const err = new Error('成片产出异常：' + (finalPath) + ' 大小 ' + ((stat && stat.size) || 0)
        + ' 字节，低于下限 ' + MIN_OUTPUT_BYTES + ' 字节，判定为渲染失败');
      log('err', err.message);
      throw err;
    }
    if (!meta) {
      const err = new Error('成片产出异常：ffprobe 无法解析 ' + finalPath + '，判定为渲染失败');
      log('err', err.message);
      throw err;
    }

    outputs.push({
      index: i + 1,
      id: `${job.id}-${i + 1}`,
      file: outName,
      url: `/files/${outName}`,
      coverFile: coverOk ? coverName : '',
      coverUrl: coverOk ? `/files/${coverName}` : '',
      width: meta.width || W,
      height: meta.height || H,
      duration: meta.duration ? Number(meta.duration.toFixed(2)) : Number((picks.length * shotSeconds).toFixed(2)),
      bytes: stat.size,
      shots: picks.length,
      ratio,
      /* 音轨标记改为反映真实情况 —— 以前硬编码 true，
         降级成静音成片时前端仍显示「有配音」，是典型的假成功。 */
      audio: hasAudio,
      bgm: !!bgm,
      voice: hasAudio && !!narration,
      subtitle: usedSub,
      sources: picks.map((p) => p.name).slice(0, 8)
    });
    log('ok', `成片 ${i + 1}/${count} 已产出：${outName} · ${outputs[outputs.length - 1].duration}s · ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
    if (typeof ctx.onOutput === 'function') { try { ctx.onOutput(outputs[outputs.length - 1]); } catch (e) {} }
    tick(`成片 ${i + 1}/${count} 已封装`);
  }

  if (typeof ctx.onMedia === 'function') { try { ctx.onMedia(media); } catch (e) {} }
  return outputs;
}

/** 背景音乐：优先 BGM_FILE，其次 <dataDir>/bgm 目录下的第一个音频文件 */
function findBgm(bgmDir) {
  const p = process.env.BGM_FILE || '';
  if (p && fs.existsSync(p)) return p;
  if (!bgmDir) return '';
  try {
    if (!fs.existsSync(bgmDir)) return '';
    const f = fs.readdirSync(bgmDir).filter((x) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(x))[0];
    return f ? path.join(bgmDir, f) : '';
  } catch (e) { return ''; }
}

/* =========================================================
   音轨封装
   ---------------------------------------------------------
   音源是三路组合，优先保证「配音听得清」：
     配音 + BGM → amix（normalize=0；否则两路各乘 0.5，人声会被压小）
     仅配音     → 直接映射，短了补静音、长了截断
     仅 BGM     → 循环铺满，压到 bgmVolume
     都没有     → 补静音底轨（部分播放器把无音轨判为异常）
   一律用 atrim 对齐到成片真实时长，避免音画不同步。
   ========================================================= */
function buildMuxArgs(video, outName, bgm, cfg, narration, bodyDur) {
  const D = Number(bodyDur) > 0 ? Number(bodyDur.toFixed(3)) : 0;
  const vol = Number(cfg.bgmVolume) || 0.18;
  const narRel = narration && narration.file ? narration.file : '';

  const tail = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'];
  if (D > 0) tail.push('-t', String(D));
  tail.push('-movflags', '+faststart', '-y', outName);

  const args = ['-i', video];

  if (narRel && bgm) {
    args.push('-i', narRel, '-stream_loop', '-1', '-i', bgm);
    args.push('-filter_complex',
      '[1:a]apad,atrim=0:' + D + ',volume=1.0[na];'
      + '[2:a]volume=' + vol + ',atrim=0:' + D + '[ba];'
      + '[na][ba]amix=inputs=2:duration=first:normalize=0[aout]',
      '-map', '0:v', '-map', '[aout]');
    return args.concat(tail);
  }
  if (narRel) {
    args.push('-i', narRel);
    args.push('-filter_complex', '[1:a]apad,atrim=0:' + D + ',volume=1.0[aout]',
      '-map', '0:v', '-map', '[aout]');
    return args.concat(tail);
  }
  if (bgm) {
    args.push('-stream_loop', '-1', '-i', bgm);
    args.push('-filter_complex', '[1:a]volume=' + vol + ',atrim=0:' + D + '[aout]',
      '-map', '0:v', '-map', '[aout]');
    return args.concat(tail);
  }

  // 无任何音源：补一条静音轨
  args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k');
  if (D > 0) args.push('-t', String(D));
  args.push('-shortest', '-movflags', '+faststart', '-y', outName);
  return args;
}

/* =========================================================
   字幕烧录
   ---------------------------------------------------------
   libass（subtitles 滤镜）优先，样式与多行支持更好；
   滤镜缺失或执行失败时**自动降级**为 drawtext 逐条烧录 ——
   字幕文案经 textfile 传入，规避引号 / 冒号 / 反斜杠的转义问题。
   两条路都失败时如实返回失败，由调用方记日志，不假装有字幕。
   ========================================================= */
async function burnSubtitles(o) {
  fs.writeFileSync(path.join(o.workDir, o.srtRel), o.srtText, 'utf8');
  const enc = ['-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p', '-y'];

  const r1 = await ff.run(['-i', o.srcRel, '-vf', 'subtitles=' + o.srtRel].concat(enc, [o.dstRel]),
    { cwd: o.workDir, signal: o.signal });
  if (r1.code === 0) return { ok: true, mode: 'libass' };

  const err1 = String(r1.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || '';
  if (o.log) o.log('warn', 'subtitles 滤镜烧录失败，改用 drawtext 逐条烧录：' + err1.slice(0, 160));

  const base = o.srtRel.replace(/subs\.srt$/, '');
  const items = (o.items || []).map((s, i) => {
    const f = base + 'sub_' + i + '.txt';
    fs.writeFileSync(path.join(o.workDir, f), String(s.text), 'utf8');
    return { start: s.start, end: s.end, file: f };
  });
  const chain = ec.subtitle.toDrawtextChain(items, { W: o.W, H: o.H, font: o.font });
  if (!chain) return { ok: false, mode: 'none', reason: '无可用字体，跳过字幕' };

  const r2 = await ff.run(['-i', o.srcRel, '-vf', chain].concat(enc, [o.dstRel]),
    { cwd: o.workDir, signal: o.signal });
  if (r2.code === 0) return { ok: true, mode: 'drawtext' };
  return { ok: false, mode: 'none', reason: String(r2.stderr || '').split('\n').filter(Boolean).slice(-1)[0] };
}

module.exports = {
  renderJob, canvasOf, RATIO_CANVAS, pickFont, fontStatus, fontCandidates, FPS
};
