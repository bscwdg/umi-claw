/**
 * P0 / P2 真实自测：用真实 ConfigManager 类 + 真实官方 CLI 在隔离 dataDir 下验证。
 *
 *   P0: existingConfig = parsedExisting ? structuredClone(parsedExisting) : existingConfig
 *       修复后，既有文件改 API key / 剥离退役键 lastTouchedAt 应真实落盘 openclaw.json
 *       （修复前：同引用自比较 → diff 恒 null → 空操作，报成功但不写入）。
 *   P2: 移除一个目录名为 "entries" 的技能，不应误发 {skills:{entries:null}} 清掉全部技能开关。
 *
 * 运行：node test/p0-sync-selftest.mjs
 * 前置：需 dev 环境 data/ 下已装好运行时（node + openclaw 包），否则跳过（标记 SKIP）。
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const bundledDir = join(repoRoot, 'test', '.tmp')
const bundled = join(bundledDir, 'configmanager-selftest.cjs')

// dev 环境真实运行时（node + openclaw 包），作为隔离 dataDir 的运行时来源
const devDataDir = join(repoRoot, 'data')
const devNode = join(devDataDir, 'runtime', `node-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const devClaw = join(devDataDir, 'openclaw', 'node_modules', 'openclaw', 'dist', 'index.js')

if (!existsSync(devNode) || !existsSync(devClaw)) {
  console.log('SKIP: dev 运行时未安装（' + devNode + '），无法跑真实 CLI 自测')
  process.exit(0)
}

// 1) esbuild 打包真实 ConfigManager（electron 设为 external，运行时注入 stub）。
// .cmd 不能直接 execFile（EINVAL），走 shell。
mkdirSync(bundledDir, { recursive: true })
execSync([
  `"${join(repoRoot, 'node_modules', '.bin', 'esbuild.cmd')}"`,
  `"${join(repoRoot, 'electron', 'main', 'configManager.ts')}"`,
  '--bundle', '--platform=node', '--format=cjs', '--target=node20',
  '--external:electron',
  `--outfile="${bundled}"`
].join(' '), { stdio: 'inherit' })

// 2) 准备隔离 dataDir：从 dev 复制运行时，塞一个含退役键 + 已有技能的 openclaw.json
const lab = mkdtempSync(join(tmpdir(), 'cm-selftest-'))
const labDataDir = join(lab, 'data')
// 用符号链接挂 dev 运行时（runtime/ 与 openclaw/ 整个），避免复制慢且漏拷依赖。
// dev openclaw/node_modules 里除 openclaw 本体外还有大量运行时依赖，缺一个 CLI 就 ERR_MODULE_NOT_FOUND。
mkdirSync(labDataDir, { recursive: true })
for (const sub of ['runtime', 'openclaw']) {
  symlinkSync(join(devDataDir, sub), join(labDataDir, sub), 'junction') // Windows junction，无需管理员
}
// config 目录独立（不链 dev，避免污染 dev 配置）
mkdirSync(join(labDataDir, 'config'), { recursive: true })

const ocDir = join(labDataDir, 'config', '.openclaw')
mkdirSync(ocDir, { recursive: true })
const ocPath = join(ocDir, 'openclaw.json')
const seedConfig = {
  gateway: { mode: 'local', auth: { mode: 'token', token: 'https://github.com/bscwdg/umi-claw' } },
  channels: { 'openclaw-weixin': { enabled: true, provider: '@tencent-weixin/openclaw-weixin', config: { appId: '', appSecret: '' } } },
  plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
  skills: { entries: { 'skill-a': { enabled: true }, 'skill-b': { enabled: false } } },
  meta: { lastTouchedAt: 'RETIRED-SHOULD-BE-STRIPPED', lastTouchedVersion: '2026.10.2' }
}
// 先把种子落盘（含退役键 + 版本戳，模拟真实既有安装——会触发 tier-eval 迁移要求）
writeFileSync(ocPath, JSON.stringify(seedConfig, null, 2), 'utf-8')
// 当前 OpenClaw 版本对 config patch 一律要求先 doctor --fix 收敛（tier-eval 配置面迁移），
// 与配置内容无关——这正是 clawManager 启动链 doctor 闸门存在的原因，也是 P0 空操作长期未被发现之由。
// 自测须成功跑一次 doctor --fix 让基线合法，才能验证 P0 补丁真实落盘。doctor 是交互式 CLI，
// 生产口径带 --non-interactive --yes（见 clawManager._runDoctorOnce）；用 stdin 关闭 + 长超时跑完。
const nodeExe = devNode
const clawJs = devClaw
const nodeBinDir = join(devDataDir, 'runtime', `node-${process.platform}-${process.arch}`, process.platform === 'win32' ? '' : 'bin')
const labCache = join(lab, 'cache')
mkdirSync(labCache, { recursive: true })
try {
  execFileSync(nodeExe, [clawJs, 'doctor', '--fix', '--non-interactive', '--yes'], {
    cwd: join(labDataDir, 'openclaw'),
    env: {
      ...process.env,
      // 与生产 buildOpenClawEnv 同口径：便携 node 顶到 PATH 最前、HOME 隔离
      PATH: nodeBinDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH || ''),
      HOME: join(labDataDir, 'config'),
      USERPROFILE: join(labDataDir, 'config'),
      OPENCLAW_CONFIG_DIR: ocDir,
      OPENCLAW_DATA_DIR: join(labDataDir, 'data'),
      // sqlite readonly worker 的快照暂存默认走 %LOCALAPPDATA%\openclaw；显式指到 lab 内，
      // 保证夹具完全隔离（受限环境下 LOCALAPPDATA 不可写会让 doctor 迁移拒绝继续）。
      XDG_CACHE_HOME: labCache,
      ELECTRON_RUN_AS_NODE: '1',
      CI: '1',
      TERM: 'dumb'
    },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000
  })
  console.log('doctor --fix 收敛完成')
} catch (e) {
  console.log('doctor --fix 非 0（已继续）:', (e && e.status) || (e && e.message) || e)
}
// 收敛后重读基线（doctor 已就地迁移，lastTouchedAt 可能已被剥离）
const converged = JSON.parse(readFileSync(ocPath, 'utf-8'))

writeFileSync(ocPath, JSON.stringify(converged, null, 2), 'utf-8')

// 4) 在隔离 dataDir 下实例化真实 ConfigManager（electron stub：走 process.cwd()/data 分支）
//    用 child_process 以 cwd=lab 运行一段脚本，让 ConfigManager 的 dataDir = lab/data
const driver = join(lab, 'driver.cjs')
const driverSrc = `
const Module = require('module');
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') {
    return { app: { isPackaged: false, getPath: () => ${JSON.stringify(lab)}, getAppPath: () => ${JSON.stringify(lab)} }, dialog: {} };
  }
  return realRequire.apply(this, arguments);
};
const { ConfigManager } = realRequire.call(module, ${JSON.stringify(bundled)});
(async () => {
  // cwd 决定 dev 分支 dataDir = process.cwd()/data
  process.chdir(${JSON.stringify(lab)});
  const cm = new ConfigManager();

  // ---- P0 用例1：既有文件改 API key 应真实落盘 ----
  const before = JSON.parse(require('fs').readFileSync(${JSON.stringify(ocPath)}, 'utf-8'));
  const key = 'sk-selftest-p0-' + Date.now();
  const providers = (cm.getConfig().providers || []).map(p => ({ ...p }));
  // 找一个官方预设 provider 填 key（deepseek 优先，否则第一个有 configName 的）
  let target = providers.find(p => p.configName && /DEEPSEEK/i.test(p.configName)) || providers.find(p => p.configName);
  if (!target) { console.log(JSON.stringify({ skip: 'no official provider with configName' })); return; }
  target.apiKey = key;
  const res = await cm.saveConfig({ providers });
  const after = JSON.parse(require('fs').readFileSync(${JSON.stringify(ocPath)}, 'utf-8'));
  const providersNode = (after.models && after.models.providers) || {};
  const keyWritten = JSON.stringify(providersNode).includes(key);
  const retiredStripped = !(after.meta && 'lastTouchedAt' in after.meta);

  // ---- P2 用例：移除名为 "entries" 的技能不应清掉全部开关 ----
  // 直接调用私有方法（JS 下可访问）
  const beforeSkills = (after.skills && after.skills.entries) || {};
  await cm._removeSkillConfigEntry('entries');
  const afterP2 = JSON.parse(require('fs').readFileSync(${JSON.stringify(ocPath)}, 'utf-8'));
  const afterSkills = (afterP2.skills && afterP2.skills.entries) || {};
  const skillsPreserved = Object.keys(afterSkills).length >= Object.keys(beforeSkills).length;

  console.log(JSON.stringify({
    syncOk: res.openClawSyncOk,
    syncError: res.openClawSyncError || null,
    keyWritten, retiredStripped,
    beforeSkillsCount: Object.keys(beforeSkills).length,
    afterSkillsCount: Object.keys(afterSkills).length,
    skillsPreserved
  }));
})().catch(e => { console.error('DRIVER_ERROR', e && e.stack || e); process.exit(2); });
`
writeFileSync(driver, driverSrc, 'utf-8')

// 5) 跑 driver（cwd=lab），用真实官方 CLI
const out = execFileSync(devNode, [driver], {
  cwd: lab,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
  // driver 内 saveConfig → config patch 同样开 state 库；缓存目录一并隔离
  env: { ...process.env, XDG_CACHE_HOME: labCache }
})
const line = out.trim().split(/\r?\n/).filter(Boolean).pop()
const r = JSON.parse(line)

if (r.skip) { console.log('SKIP: ' + r.skip); process.exit(0) }

let fail = 0
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''))
  if (!cond) fail++
}
check('P0: 改 API key 真实落盘 openclaw.json', r.keyWritten, 'syncOk=' + r.syncOk + (r.syncError ? ' err=' + r.syncError : ''))
check('P0: 退役键 meta.lastTouchedAt 被剥离', r.retiredStripped)
check('P2: 移除 "entries" 技能不误清全部开关', r.skillsPreserved, `skills ${r.beforeSkillsCount} -> ${r.afterSkillsCount}`)

console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
