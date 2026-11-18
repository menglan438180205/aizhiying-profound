/* =========================================================
   PFQR —— 极简二维码编码器（零依赖）
   ---------------------------------------------------------
   为什么要自己写：原来的 drawQR() 是「确定性伪随机点阵」，
   扫不出任何内容，导致所有扫码入口形同虚设。
   本实现按 ISO/IEC 18004 生成真实可扫的二维码：
     · 字节模式（UTF-8）、自动选版本 1–10、纠错等级 M
     · 容量上限 213 字节（版本 10-M），足够放下 OAuth 授权链接
     · 自动掩码（8 种按惩罚分择优）
   对外只有两个方法：PFQR.matrix(text) / PFQR.draw(canvas, text, opt)
   ========================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PFQR = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ---------- GF(256) 有限域 ---------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  /* ---------- 分块规格（纠错等级 M，版本 1–10） ----------
     [每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字] */
  var SPEC = [
    null,
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44]
  ];
  var MAX_VER = 10;

  /* 对齐图案中心坐标（版本 1 无） */
  var ALIGN = [
    null, [],
    [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  function dataCw(v) { var s = SPEC[v]; return s[1] * s[2] + s[3] * s[4]; }
  function totalCw(v) { var s = SPEC[v]; return dataCw(v) + (s[1] + s[3]) * s[0]; }
  /* 版本 2–6 末尾有 7 个剩余位，7 以上为 0 */
  function remainderBits(v) { return (v >= 2 && v <= 6) ? 7 : 0; }

  /* ---------- Reed–Solomon ---------- */
  function rsGen(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var ng = new Array(g.length + 1);
      for (var k = 0; k < ng.length; k++) ng[k] = 0;
      for (var j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gmul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }
  function rsEncode(data, ecLen) {
    var gen = rsGen(ecLen);
    var buf = data.slice();
    for (var i = 0; i < ecLen; i++) buf.push(0);
    for (var p = 0; p < data.length; p++) {
      var f = buf[p];
      if (!f) continue;
      for (var j = 0; j < gen.length; j++) buf[p + j] ^= gmul(gen[j], f);
    }
    return buf.slice(data.length);
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(str));
    var out = [], s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  /* ---------- 位流 ---------- */
  function buildCodewords(bytes, ver) {
    var cap = dataCw(ver) * 8;
    var ccBits = ver < 10 ? 8 : 16;
    var bits = [];
    function push(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    push(0x4, 4);                 /* 字节模式 */
    push(bytes.length, ccBits);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);
    var term = Math.min(4, cap - bits.length);
    for (i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var out = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    var pad = [0xEC, 0x11], k = 0;
    while (out.length < dataCw(ver)) out.push(pad[k++ % 2]);
    return out;
  }

  function interleave(data, ver) {
    var s = SPEC[ver];
    var blocks = [], k = 0, i;
    for (i = 0; i < s[1]; i++) { blocks.push(data.slice(k, k + s[2])); k += s[2]; }
    for (i = 0; i < s[3]; i++) { blocks.push(data.slice(k, k + s[4])); k += s[4]; }
    var eccs = blocks.map(function (b) { return rsEncode(b, s[0]); });
    var out = [], maxD = 0;
    blocks.forEach(function (b) { if (b.length > maxD) maxD = b.length; });
    for (i = 0; i < maxD; i++) {
      for (var j = 0; j < blocks.length; j++) if (i < blocks[j].length) out.push(blocks[j][i]);
    }
    for (i = 0; i < s[0]; i++) {
      for (j = 0; j < eccs.length; j++) out.push(eccs[j][i]);
    }
    return out;
  }

  /* ---------- 矩阵 ---------- */
  function Matrix(ver) {
    this.ver = ver;
    this.size = 17 + ver * 4;
    this.m = new Int8Array(this.size * this.size);   /* -1 未定，0 白，1 黑 */
    this.fn = new Uint8Array(this.size * this.size); /* 1 表示功能图形（不参与掩码） */
    this.m.fill(-1);
  }
  Matrix.prototype.set = function (x, y, dark) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    var i = y * this.size + x;
    this.m[i] = dark ? 1 : 0;
    this.fn[i] = 1;
  };
  Matrix.prototype.get = function (x, y) { return this.m[y * this.size + x] === 1; };

  Matrix.prototype.drawFunctionPatterns = function () {
    var size = this.size, i, j;
    var self = this;

    function finder(ox, oy) {
      for (var dy = -1; dy <= 7; dy++) {
        for (var dx = -1; dx <= 7; dx++) {
          var x = ox + dx, y = oy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          var inner = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          var dark = inner && (dx === 0 || dx === 6 || dy === 0 || dy === 6 ||
            (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
          self.set(x, y, dark);
        }
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    /* 定位线 */
    for (i = 8; i < size - 8; i++) {
      this.set(i, 6, i % 2 === 0);
      this.set(6, i, i % 2 === 0);
    }

    /* 对齐图案 */
    var pos = ALIGN[this.ver];
    for (i = 0; i < pos.length; i++) {
      for (j = 0; j < pos.length; j++) {
        var cx = pos[i], cy = pos[j];
        if ((cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)) continue;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    /* 预留格式信息区（先填空，稍后按掩码重写）
       注意：x=8 与 y=8 的 i=6 是定位线交点，必须保留定位线颜色，不能清成白色 */
    for (i = 0; i <= 8; i++) {
      if (i !== 6) { this.set(8, i, false); this.set(i, 8, false); }
    }
    for (i = 0; i < 8; i++) { this.set(size - 1 - i, 8, false); this.set(8, size - 1 - i, false); }
    /* 固定黑点 */
    this.set(8, size - 8, true);

    /* 版本信息（7 以上） */
    if (this.ver >= 7) {
      var rem = this.ver;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = (this.ver << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = (vbits >>> i) & 1;
        var a = size - 11 + (i % 3), b = Math.floor(i / 3);
        this.set(a, b, bit);
        this.set(b, a, bit);
      }
    }
  };

  Matrix.prototype.placeData = function (bits) {
    var size = this.size, idx = 0, up = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;            /* 跳过定位列 */
      for (var vert = 0; vert < size; vert++) {
        var y = up ? size - 1 - vert : vert;
        for (var c = 0; c < 2; c++) {
          var x = right - c;
          var i = y * size + x;
          if (this.fn[i]) continue;
          this.m[i] = idx < bits.length ? bits[idx++] : 0;
        }
      }
      up = !up;
    }
  };

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  function formatBits(mask) {
    /* 纠错等级 M 的两位标识为 00 */
    var data = (0 << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  Matrix.prototype.applyMask = function (mask) {
    var size = this.size;
    var out = new Int8Array(this.m);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var i = y * size + x;
        if (this.fn[i]) continue;
        if (maskBit(mask, x, y)) out[i] ^= 1;
      }
    }
    /* 写入格式信息 */
    var f = formatBits(mask);
    var bit = function (k) { return (f >>> k) & 1; };
    var put = function (x, y, v) { out[y * size + x] = v ? 1 : 0; };
    for (var i = 0; i <= 5; i++) put(8, i, bit(i));
    put(8, 7, bit(6));
    put(8, 8, bit(7));
    put(7, 8, bit(8));
    for (i = 9; i < 15; i++) put(14 - i, 8, bit(i));
    for (i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
    for (i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
    put(8, size - 8, 1);
    return out;
  };

  function penalty(m, size) {
    var score = 0, x, y, i, run, dark = 0;
    /* N1 连续同色 */
    for (y = 0; y < size; y++) {
      run = 1;
      for (x = 1; x < size; x++) {
        if (m[y * size + x] === m[y * size + x - 1]) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (x = 0; x < size; x++) {
      run = 1;
      for (y = 1; y < size; y++) {
        if (m[y * size + x] === m[(y - 1) * size + x]) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    /* N2 2×2 同色 */
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var a = m[y * size + x];
        if (a === m[y * size + x + 1] && a === m[(y + 1) * size + x] && a === m[(y + 1) * size + x + 1]) score += 3;
      }
    }
    /* N3 类似定位图形的 1:1:3:1:1 */
    var pat = [1, 0, 1, 1, 1, 0, 1];
    function hit(get, n, from) {
      for (var k = 0; k < 7; k++) if (get(from + k) !== pat[k]) return false;
      var before = true, after = true;
      for (k = 1; k <= 4; k++) { if (from - k < 0) break; if (get(from - k) !== 0) { before = false; break; } }
      for (k = 7; k <= 10; k++) { if (from + k >= n) break; if (get(from + k) !== 0) { after = false; break; } }
      return before || after;
    }
    for (y = 0; y < size; y++) {
      for (x = 0; x <= size - 7; x++) {
        if (hit(function (k) { return m[y * size + k]; }, size, x)) { score += 40; x += 6; }
      }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y <= size - 7; y++) {
        if (hit(function (k) { return m[k * size + x]; }, size, y)) { score += 40; y += 6; }
      }
    }
    /* N4 黑白比例 */
    for (i = 0; i < m.length; i++) if (m[i]) dark++;
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  /* ---------- 对外 ---------- */
  function matrix(text) {
    var bytes = utf8(String(text == null ? '' : text));
    var ver = 0;
    for (var v = 1; v <= MAX_VER; v++) {
      var ccBits = v < 10 ? 8 : 16;
      if (bytes.length >= (1 << ccBits)) continue;
      if (4 + ccBits + bytes.length * 8 <= dataCw(v) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('内容过长：最多 213 字节（当前 ' + bytes.length + '）');

    var cw = interleave(buildCodewords(bytes, ver), ver);
    var bits = [];
    for (var i = 0; i < cw.length; i++) {
      for (var b = 7; b >= 0; b--) bits.push((cw[i] >>> b) & 1);
    }
    for (i = 0; i < remainderBits(ver); i++) bits.push(0);

    var mtx = new Matrix(ver);
    mtx.drawFunctionPatterns();
    mtx.placeData(bits);

    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mask = 0; mask < 8; mask++) {
      var cand = mtx.applyMask(mask);
      var sc = penalty(cand, mtx.size);
      if (sc < bestScore) { bestScore = sc; best = cand; bestMask = mask; }
    }
    if (cw.length !== totalCw(ver)) throw new Error('码字数量异常');
    return { size: mtx.size, version: ver, mask: bestMask, modules: best };
  }

  function draw(canvas, text, opt) {
    if (!canvas) return null;
    opt = opt || {};
    var q = matrix(text);
    var quiet = opt.quiet == null ? 4 : opt.quiet;
    var total = q.size + quiet * 2;
    var px = opt.pixel || Math.max(2, Math.floor((opt.width || 180) / total));
    var side = total * px;
    canvas.width = side;
    canvas.height = side;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opt.light || '#ffffff';
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = opt.dark || '#161528';
    for (var y = 0; y < q.size; y++) {
      for (var x = 0; x < q.size; x++) {
        if (q.modules[y * q.size + x]) ctx.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
      }
    }
    return q;
  }

  return {
    matrix: matrix,
    draw: draw,
    capacity: function (v) { return dataCw(v || MAX_VER); },
    version: '1.0.0'
  };
});
