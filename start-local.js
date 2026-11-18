#!/usr/bin/env node
/**
 * 本地体验启动器（跨平台）
 * -------------------------------------------------------------
 * 作用：读取 .env.local 注入到服务端进程环境（服务端本身不读 .env），
 *       检测端口占用，拉起 server/index.js，并转发信号以便干净退出。
 *
 * 用法：
 *   node start-local.js            # 前台运行（Ctrl+C 停止）
 *   node start-local.js --check    # 只看配置与端口，不真正启动
 *   node start-local.js --daemon   # 后台常驻（脱离父进程，不随会话关闭而退出）
 *   node start-local.js --stop     # 停止 --daemon 起的后台服务
 *   node start-local.js --status   # 查看后台服务状态
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env.local');
const RUN_DIR = path.join(ROOT, '.data');
const PID_FILE = path.join(RUN_DIR, 'server.pid');
const LOG_FILE = path.join(RUN_DIR, 'server.log');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

function applyEnv(env) {
  // .env.local 只补缺口：已存在的进程环境变量优先（便于 CLI 临时覆盖）
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// 组装给子进程的完整环境（显式合并，避免 detached 场景下丢变量）
function buildChildEnv(env) {
  const out = Object.assign({}, process.env);
  for (const [k, v] of Object.entries(env)) {
    if (out[k] === undefined || out[k] === '') out[k] = v;
  }
  return out;
}

function portFree(host, port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const done = (free) => { if (!settled) { settled = true; sock.destroy(); resolve(free); } };
    sock.setTimeout(800);
    sock.once('connect', () => done(false)); // 能连上 => 被占用
    sock.once('error', () => done(true));     // 连接被拒 => 空闲
    sock.once('timeout', () => done(true));
  });
}

function checkOnly() {
  const env = parseEnvFile(ENV_FILE);
  console.log('[start-local] 将从', ENV_FILE, '注入以下变量：');
  for (const [k, v] of Object.entries(env)) {
    console.log(`   ${k}=${v === '' ? '(空)' : v}`);
  }
  console.log(`[start-local] 目标地址 ${env.HOST || HOST}:${Number(env.PORT || PORT)}`);
}

/* ---------------- 后台常驻（daemon）相关 ---------------- */

function readPid() {
  try {
    const n = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) { return 0; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function pidFromPort() {
  // 兜底：从端口占用反查 PID（Windows netstat / POSIX lsof）
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' });
      const m = out.split(/\r?\n/).find((l) => /LISTENING/i.test(l));
      if (m) { const p = m.trim().split(/\s+/).pop(); return Number(p) || 0; }
    } else {
      const out = execSync(`lsof -ti tcp:${PORT}`, { encoding: 'utf8' });
      return Number(out.trim().split(/\n/)[0]) || 0;
    }
  } catch (e) { /* ignore */ }
  return 0;
}

function stopDaemon() {
  const pid = readPid() || pidFromPort();
  if (!pid || !isAlive(pid)) {
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    console.log('[start-local] 未发现正在运行的后台服务。');
    process.exit(0);
  }
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    console.log(`[start-local] 已停止后台服务（PID ${pid}）。`);
  } catch (e) {
    console.error(`[start-local] 停止失败：${e.message}`);
  }
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
  process.exit(0);
}

async function statusDaemon() {
  const env = parseEnvFile(ENV_FILE);
  const host = env.HOST || HOST;
  const port = Number(env.PORT || PORT);
  const pid = readPid();
  const alive = isAlive(pid);
  const free = await portFree(host, port);
  console.log(`[start-local] PID 文件：${pid || '(无)'}  进程存活：${alive ? '是' : '否'}`);
  console.log(`[start-local] 端口 ${port}：${free ? '空闲' : '被占用（服务在跑）'}`);
  console.log(`[start-local] 日志文件：${LOG_FILE}`);
  console.log(`[start-local] 入口：http://${host}:${port}/app/`);
  process.exit(0);
}

async function startDaemon() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const env = parseEnvFile(ENV_FILE);
  const pid = readPid();
  if (pid && isAlive(pid)) {
    console.log(`[start-local] 后台服务已在运行（PID ${pid}），无需重复启动。`);
    console.log(`[start-local] 入口：http://${HOST}:${PORT}/app/`);
    process.exit(0);
  }
  const free = await portFree(HOST, PORT);
  if (!free) {
    console.error(`\n[start-local] ❌ 端口 ${PORT} 已被占用，无法启动。可先执行：node start-local.js --stop\n`);
    process.exit(1);
  }

  // 跨平台统一：用 Node 自身的 spawn(detached:true) 派生独立进程。
  // Windows 上 detached 会创建新进程组、脱离父控制台，父进程退出后子进程继续存活；
  // POSIX 上同样脱离会话。stdio 直接重定向到日志文件，避免控制台丢失。
  const host = env.HOST || HOST;
  const port = Number(env.PORT || PORT);
  const logFd = fs.openSync(LOG_FILE, 'a');
  const errFd = fs.openSync(path.join(RUN_DIR, 'server.err.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: buildChildEnv(env),
    detached: true,
    stdio: ['ignore', logFd, errFd],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  console.log(`[start-local] ✅ 后台服务已启动（PID ${child.pid}），不随本会话关闭而退出。`);
  console.log(`[start-local] 入口：http://${host}:${port}/app/`);
  console.log(`[start-local] 日志：${LOG_FILE}`);
  console.log(`[start-local] 停止：node start-local.js --stop`);
  process.exit(0);
}

async function main() {
  const env = parseEnvFile(ENV_FILE);
  applyEnv(env);

  if (process.argv.includes('--check')) {
    checkOnly();
    const host = env.HOST || HOST;
    const port = Number(env.PORT || PORT);
    const free = await portFree(host, port);
    console.log(`[start-local] 端口 ${port} ${free ? '空闲 ✓' : '已被占用 ✗'}`);
    process.exit(free ? 0 : 1);
  }

  // 数据目录兜底
  const dataDir = env.DATA_DIR || process.env.DATA_DIR || path.join(ROOT, '.data');
  fs.mkdirSync(dataDir, { recursive: true });

  if (process.argv.includes('--stop')) return stopDaemon();
  if (process.argv.includes('--status')) return statusDaemon();
  if (process.argv.includes('--daemon')) return startDaemon();

  // --foreground：仅由 --daemon 内部调用的守护态，直接以前台方式跑 server
  const isForeground = process.argv.includes('--foreground');

  const host = env.HOST || HOST;
  const port = Number(env.PORT || PORT);
  const free = await portFree(host, port);
  if (!free) {
    if (isForeground) {
      // 守护态下端口占用多半是上一份没退干净，记日志即可
      console.error(`[start-local] 端口 ${port} 已被占用，守护进程退出。`);
      process.exit(1);
    }
    console.error(`\n[start-local] ❌ 端口 ${port} 已被占用，请先关闭占用进程或改 .env.local 的 PORT。\n`);
    process.exit(1);
  }

  if (!isForeground) {
    const host = env.HOST || HOST;
    const port = Number(env.PORT || PORT);
    console.log(`\n[start-local] 启动本地服务端 → http://${host}:${port}`);
    console.log(`[start-local] 体验入口：http://${host}:${port}/app/  （前端自动探测本机 BFF）\n`);
  }

  const childEnv = isForeground ? process.env : buildChildEnv(env);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
  });

  const shutdown = (sig) => {
    if (!isForeground) console.log(`\n[start-local] 收到 ${sig}，正在停止服务端…`);
    child.kill(sig);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (!isForeground) console.log(`[start-local] 服务端已退出（code=${code}, signal=${signal || '-'}）`);
    process.exit(code || 0);
  });
}

main().catch((e) => {
  console.error('[start-local] 启动失败：', e);
  process.exit(1);
});
