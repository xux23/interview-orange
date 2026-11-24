/**
 * 干净 clone 构建检查（CI 与本地通用）：
 *   1) 从当前仓库 HEAD 做一次浅克隆（不含工作区未提交文件）；
 *   2) 校验构建/运行必需的核心文件确实在版本控制里；
 *   3) 对 server/ 全量做 node --check（语法闸门）；
 *   4) 可选：--with-install 时 npm ci + vite build（需要网络）。
 * 用法：node scripts/check-clean-clone.mjs [--with-install]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const withInstall = process.argv.includes('--with-install');
const repoRoot = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-clean-clone-'));
const cloneDir = path.join(tmp, 'clone');
const results = [];
const check = (ok, name, extra = '') => {
  results.push([ok ? 'PASS' : 'FAIL', name, extra]);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
};

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
}

try {
  run('git', ['clone', '--depth', '1', '--no-local', '.', cloneDir], repoRoot);
  check(true, '从 HEAD 浅克隆成功', cloneDir);

  const required = [
    'package.json',
    'package-lock.json',
    'server/index.js',
    'server/socket.js',
    'server/settings.js',
    'server/trpc/session.js',
    'server/ai/enrich.js',
    'web/src/main.jsx',
    'web/index.html',
    'native/Cargo.toml',
    'native/build.ps1',
    'native/run.ps1',
    'native/toolchain.ps1',
    'native/tools/gcc-shim.c',
    'native/tools/windres-shim.c',
    'scripts/ai-config-e2e.mjs',
    'scripts/asr-config-e2e.mjs',
    '.env.example',
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(cloneDir, f)));
  check(missing.length === 0, '核心文件已入库（干净 clone 可构建）', missing.length ? `缺少: ${missing.join(', ')}` : `${required.length} 个文件齐全`);

  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  const serverFiles = walk(path.join(cloneDir, 'server'));
  let syntaxErrors = 0;
  for (const f of serverFiles) {
    try {
      run(process.execPath, ['--check', f], cloneDir);
    } catch (e) {
      syntaxErrors += 1;
      console.log('   语法错误:', f, String(e.stderr || e.message).slice(0, 200));
    }
  }
  check(syntaxErrors === 0, 'server 全量 node --check 通过', `${serverFiles.length} 个文件`);

  if (withInstall) {
    run('npm', ['ci', '--no-audit', '--no-fund'], cloneDir);
    run('npm', ['run', 'build'], cloneDir);
    check(fs.existsSync(path.join(cloneDir, 'public', 'index.html')), '干净 clone 可完成前端构建');
  } else {
    console.log('[SKIP] --with-install 未开启，跳过 npm ci + 前端构建');
  }
} catch (e) {
  check(false, '干净 clone 检查执行失败', String(e.message || e).slice(0, 300));
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* ignore */ }
}

const fails = results.filter(([s]) => s === 'FAIL').length;
console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
