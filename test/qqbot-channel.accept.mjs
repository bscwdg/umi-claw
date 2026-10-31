// test/qqbot-channel.accept.mjs —— QQ 机器人渠道（应用侧接线 + ClawManager 状态）
//
// 覆盖：
// 1) channelManager.getChannelStatuses 识别 channels.qqbot（含 accounts.* 多账号）
// 2) downloadManager 受管安装/刷新 QQ 官方插件
// 3) configManager 注入 channels.qqbot + 启用 openclaw-qqbot，且表单为空不删除扫码写入的绑定
// 4) 渠道页存在 QQ 卡片与「扫码登录」跳转（channels login --channel qqbot）
//
// 用法：node test/qqbot-channel.accept.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpDir = join(root, 'test', '.tmp')
mkdirSync(tmpDir, { recursive: true })

let passed = 0
const failures = []
function check(name, fn) {
  try {
    const detail = fn()
    passed++
    console.log(`[PASS] ${name}${detail ? '  -> ' + detail : ''}`)
  } catch (e) {
    failures.push(name + ': ' + (e?.message || e))
    console.log(`[FAIL] ${name}: ${e?.message || e}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} — 期望 ${expected}，实际 ${actual}`)
}

function bundleChannelManager() {
  const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
  assert(existsSync(bin), `未找到 esbuild: ${bin}`)
  const outfile = join(tmpDir, 'qqbot-channel-manager.mjs')
  const res = spawnSync(
    bin,
    [join(root, 'electron', 'main', 'channelManager.ts'), '--bundle', '--platform=node', '--format=esm', '--target=node20', '--external:electron', '--log-level=warning', `--outfile=${outfile}`],
    { cwd: root, encoding: 'utf-8', shell: process.platform === 'win32' }
  )
  assert(res.status === 0, `esbuild 失败: ${res.stderr || res.stdout}`)
  return outfile
}

const sandbox = mkdtempSync(join(tmpdir(), 'umi-qqbot-accept-'))
try {
  const bundle = bundleChannelManager()
  const { ChannelManager } = await import(pathToFileURL(bundle).href)
  const fakeConfig = (channels) => ({
    getDataDir: () => sandbox,
    getNodePath: () => process.execPath,
    getOpenClawChannels: () => channels
  })

  check('qqbot-status', () => {
    const cm0 = new ChannelManager(fakeConfig({}))
    const st0 = cm0.getChannelStatuses()
    assertEq(st0.length, 6, '渠道状态应包含 6 个 key')
    assertEq(st0.find((s) => s.key === 'qqbot')?.configured, false, '无配置时 qqbot=false')
    const cm1 = new ChannelManager(fakeConfig({ qqbot: { appId: '102030405', clientSecret: 's' } }))
    const qq1 = cm1.getChannelStatuses().find((s) => s.key === 'qqbot')
    assertEq(qq1?.configured, true, 'appId+clientSecret 视为已配置')
    assert(String(qq1?.detail || '').includes('102030405'), 'detail 带 AppID 前缀')
    const cm2 = new ChannelManager(
      fakeConfig({ qqbot: { accounts: { bot2: { appId: '2', clientSecret: 's2' } } } })
    )
    assertEq(cm2.getChannelStatuses().find((s) => s.key === 'qqbot')?.configured, true, 'accounts.* 也算已配置')
    const projectsDir = join(sandbox, 'config', '.openclaw', 'npm', 'projects')
    mkdirSync(join(projectsDir, 'tencent-connect-openclaw-qqbot-a7ec020d86'), { recursive: true })
    mkdirSync(join(projectsDir, 'openclaw-feishu-deadbeef'), { recursive: true })
    const cm3 = new ChannelManager(fakeConfig({}))
    assertEq(cm3.isPluginInstalled('qqbot'), true, '受管 QQ 插件目录应被识别')
    assertEq(cm3.isPluginInstalled('feishu'), true, '飞书受管目录识别不回归')
    assertEq(cm3.isPluginInstalled('wecom'), false, '未安装渠道不误判')
    return '状态识别 ✓'
  })

  check('qqbot-wiring', () => {
    const dm = readFileSync(join(root, 'electron', 'main', 'downloadManager.ts'), 'utf-8')
    const cfg = readFileSync(join(root, 'electron', 'main', 'configManager.ts'), 'utf-8')
    const page = readFileSync(join(root, 'src', 'views', 'ChannelsPage.vue'), 'utf-8')
    const types = readFileSync(join(root, 'src', 'types', 'channels.ts'), 'utf-8')
    assert(/@tencent-connect\/openclaw-qqbot/.test(dm), 'downloadManager 使用官方 QQ 插件包名')
    assert(/_installQQBotChannelPlugin/.test(dm), '存在 QQ 插件受管安装')
    assert(/_getQQBotManagedPluginDir/.test(dm), '存在 QQ 受管目录解析')
    assert(/channels\.qqbot/.test(cfg), 'configManager 注入 channels.qqbot')
    assert(/openclaw-qqbot/.test(cfg), 'configManager 启用 openclaw-qqbot 插件条目')
    assert(!/delete existingConfig\.channels\.qqbot/.test(cfg), '不得删除扫码写入的 qqbot 配置')
    assert(/QQ 机器人（官方插件）/.test(page), '渠道页有 QQ 卡片')
    assert(/channels login --channel qqbot/.test(page), '扫码登录跳转 channels login --channel qqbot')
    assert(/defaultRequireMention/.test(cfg), 'QQ 群「需 @」必须写 defaultRequireMention')
    assert(/allowFrom/.test(cfg) && /dmPolicy/.test(cfg), 'QQ 配置必须补 allowFrom/dmPolicy（新版 schema 要求）')
    assert(/qqPluginInstalled|tencent-connect-openclaw-qqbot-/.test(cfg), '插件未安装时不得注入 channels.qqbot')
    assert(/policyOnly/.test(page), '扫码用户无凭证也能提交群策略')
    assert(/qqbotBusy/.test(page), '扫码按钮防连点/显示安装中')
    assert(/qqbot/.test(types), 'ChannelStatusKey 包含 qqbot')
    return '安装/配置/UI 接线 ✓'
  })
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('')
console.log(`----- QQ 机器人渠道验收: ${passed}/${passed + failures.length}，失败 ${failures.length} -----`)
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
