'use strict';
/* =========================================================
   check-sync.js — 校验 index.html 是否等于 src/ 的构建结果
   ---------------------------------------------------------
   以前校验的是「只读镜像有没有过期」（真相在 index.html）；
   现在方向反了：真相在 src/，index.html 是产物，这里校验产物
   有没有在该改的时候重新构建。

   用法：
       node scripts/check-sync.js            仅提示，退出码 0
       node scripts/check-sync.js --strict   不一致时退出码 1（提交前钩子）
   ========================================================= */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.indexOf('--strict') > -1;

let code = 0;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js'), '--check'], { stdio: 'inherit' });
} catch (e) {
  code = e.status || 1;
}

if (code) {
  console.log('\nindex.html 与 src/ 不一致。执行：node scripts/build.js');
  console.log('（唯一真相是 src/；不要手改 index.html，否则下次构建会被覆盖）');
  if (STRICT) process.exit(1);
}
