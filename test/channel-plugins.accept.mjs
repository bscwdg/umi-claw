// test/channel-plugins.accept.mjs —— 渠道插件注册表 / ensurePlugin / IPC 行为验收
//
// 为什么需要它：飞书/QQ/微信/企微/Slack 的安装判定以前散在 ChannelManager、downloadManager、
// ChannelsPage 三处，且「受管目录存在」就被当成已安装（安装回滚残留的空目录会让 UI 跳过安装）；
// 删掉任一渠道插件后应用内没有装回的入口。本套件用真源码 + 临时受管目录 + fake ConfigManager：
//   P1 注册表判定：空目录 / 残缺包 / 包名不符 → 未安装；完整包 → 已安装（含版本）
//   P2 ensurePlugin：已装→只启用 / 缺失→安装+启用 / 装失败 / 装后仍缺 / 启用失败 / 未知 key /
//                   并发只装一次 / force 重装 / 各渠道 openclaw 插件 id 映射
//   P3 IPC 行为：key 白名单、异常转 {success:false}、presence 透传
//   P4 应用侧接线（静态）：Setup/渠道页/preload/configManager 都接上新入口
//
// 用法：node test/channel-plugins.accept.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  assert,
  assertEq,
  assertDeepEq,
  bundleEntry,
  printResult,
  writeJson,
  repoRoot
} from './_lib.mjs'

const registryPath = bundleEntry(
  'electron/main/claw/channelPlugins.ts',
  'channel-plugins-registry.mjs'
)
const managerPath = bundleEntry(
  'electron/main/channelManager.ts',
  'channel-plugins-manager.mjs'
)
const ipcPath = bundleEntry(
  'electron/main/ipc/host/channels.ts',
  'channel-plugins-ipc.mjs'
)

const registry = await import(pathToFileURL(registryPath).href)
const { ChannelManager } = await import(pathToFileURL(managerPath).href)
const { registerChannelsIpc } = await import(pathToFileURL(ipcPath).href)

const {
  CHANNEL_PLUGINS,
  CHANNEL_PLUGIN_KEYS,
  buildPluginInstallArgs,
  getChannelPluginPresence,
  isChannelPluginInstalled
} = registry

/**
 * 独立维护的期望表（不引用被测注册表本身）。
 * 否则 registry 里把 slack 的 projectPrefix 写错，测试会跟着生成同一个错误目录而全绿。
 */
const EXPECTED_PLUGINS = {
  weixin: {
    packageName: '@tencent-weixin/openclaw-weixin',
    openclawPluginId: 'openclaw-weixin',
    projectPrefix: 'tencent-weixin-openclaw-weixin'
  },
  qqbot: {
    packageName: '@tencent-connect/openclaw-qqbot',
    openclawPluginId: 'openclaw-qqbot',
    projectPrefix: 'tencent-connect-openclaw-qqbot'
  },
  feishu: {
    packageName: '@openclaw/feishu',
    openclawPluginId: 'feishu',
    projectPrefix: 'openclaw-feishu'
  },
  wecom: {
    packageName: '@wecom/wecom-openclaw-plugin',
    openclawPluginId: 'wecom-openclaw-plugin',
    projectPrefix: 'wecom-wecom-openclaw-plugin'
  },
  slack: {
    packageName: '@openclaw/slack',
    openclawPluginId: 'slack',
    projectPrefix: 'openclaw-slack'
  }
}

const rec = new Recorder('渠道插件注册表 / ensurePlugin / IPC 验收')
const tempDirs = []

/** 建一个 dataDir 沙盒；openclaw 配置目录 = <dataDir>/config/.openclaw */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'umi-channel-plugins-'))
  tempDirs.push(dir)
  return dir
}

function configDirOf(dataDir) {
  return join(dataDir, 'config', '.openclaw')
}

/**
 * 写一个受管插件项目：<configDir>/npm/projects/<prefix>-<10位hash>/node_modules/<pkg...>
 * 目录名用 EXPECTED_PLUGINS 里的显式前缀生成，不依赖被测注册表；
 * declaredName 可覆盖，用来模拟「包名不符的残缺包」。
 */
function writeManagedProject(dataDir, key, options = {}) {
  const expected = EXPECTED_PLUGINS[key]
  const {
    prefix = expected.projectPrefix,
    hash = 'deadbeef00',
    declaredName = expected.packageName,
    version = '2026.11.1',
    withPackageJson = true
  } = options
  const pkgDir = join(
    configDirOf(dataDir),
    'npm',
    'projects',
    `${prefix}-${hash}`,
    'node_modules',
    ...expected.packageName.split('/')
  )
  mkdirSync(pkgDir, { recursive: true })
  if (withPackageJson) {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: declaredName, version }),
      'utf-8'
    )
  }
  return pkgDir
}

function keyByPackage(packageName) {
  return CHANNEL_PLUGIN_KEYS.find((key) => CHANNEL_PLUGINS[key].packageName === packageName)
}

/** fake ConfigManager：只提供 ChannelManager 真正会用到的方法 */
function makeConfigManager(dataDir, options = {}) {
  const calls = { enable: [] }
  const manager = {
    getDataDir: () => dataDir,
    getNodePath: () => process.execPath,
    getConfig: () => ({ useChineseMirror: false }),
    getOpenClawChannels: () => ({}),
    ensureOpenClawPluginEnabled: async (pluginId) => {
      calls.enable.push(pluginId)
      return options.enableResult ?? { ok: true, alreadyEnabled: false }
    }
  }
  return { manager, calls }
}

try {
  // ── P1 注册表判定 ──────────────────────────────────────────────────────────
  await rec.check('P1', '注册表：包名/id/前缀与期望表一致；空目录/残缺包/包名不符不算已安装', async () => {
    assertEq(
      CHANNEL_PLUGIN_KEYS.join(','),
      'weixin,qqbot,feishu,wecom,slack',
      '渠道插件顺序固定（UI 依此渲染）'
    )
    // 与独立期望表逐字段比对：注册表把某个前缀/插件 id 写错时这里必红
    for (const key of CHANNEL_PLUGIN_KEYS) {
      const spec = CHANNEL_PLUGINS[key]
      const expected = EXPECTED_PLUGINS[key]
      assertEq(spec.packageName, expected.packageName, `${key} 包名`)
      assertEq(spec.openclawPluginId, expected.openclawPluginId, `${key} openclaw 插件 id`)
      assertEq(spec.projectPrefix, expected.projectPrefix, `${key} 受管目录前缀`)
    }

    const dataDir = makeSandbox()
    const cfgDir = configDirOf(dataDir)
    let presence = getChannelPluginPresence(cfgDir)
    assertEq(presence.length, 5, 'presence 覆盖全部 5 个渠道插件')
    assert(
      presence.every((p) => !p.installed),
      '空受管目录：全部未安装'
    )

    // 空项目目录（安装回滚残留）：不能算已安装
    mkdirSync(join(cfgDir, 'npm', 'projects', 'openclaw-feishu-deadbeef00'), { recursive: true })
    assertEq(isChannelPluginInstalled(cfgDir, 'feishu'), false, '空目录不算已安装')

    // 包名不符的残缺包：同样不算
    writeManagedProject(dataDir, 'feishu', { declaredName: '@openclaw/not-feishu' })
    assertEq(isChannelPluginInstalled(cfgDir, 'feishu'), false, '包名不符不算已安装')

    // 前缀相近的其它插件不能误匹配（openclaw-slack-huddles 不是 openclaw-slack）
    const hudDir = join(
      cfgDir,
      'npm',
      'projects',
      'openclaw-slack-huddles-aabbccddee',
      'node_modules',
      '@openclaw',
      'slack-huddles'
    )
    mkdirSync(hudDir, { recursive: true })
    writeFileSync(
      join(hudDir, 'package.json'),
      JSON.stringify({ name: '@openclaw/slack-huddles' }),
      'utf-8'
    )
    assertEq(isChannelPluginInstalled(cfgDir, 'slack'), false, '前缀相近的其它插件不误判为 slack')

    // 完整包：算已安装，并带版本
    const dataDir2 = makeSandbox()
    writeManagedProject(dataDir2, 'feishu', { version: '2026.11.1' })
    writeManagedProject(dataDir2, 'weixin', { version: '2.4.10' })
    const cfgDir2 = configDirOf(dataDir2)
    assertEq(isChannelPluginInstalled(cfgDir2, 'feishu'), true, '完整飞书包 → 已安装')
    assertEq(isChannelPluginInstalled(cfgDir2, 'qqbot'), false, '未装渠道不误判')
    presence = getChannelPluginPresence(cfgDir2)
    assertEq(presence.find((p) => p.key === 'feishu')?.version, '2026.11.1', 'presence 带版本')
    assertEq(presence.find((p) => p.key === 'weixin')?.installed, true, 'presence 微信已安装')
    return '包名/id/前缀与期望表一致；空目录/残缺包/前缀相近插件 → 未安装'
  })

  // ── P2 ensurePlugin 行为 ──────────────────────────────────────────────────
  await rec.check('P2', 'ensurePlugin：只装缺失、装完启用、失败可读、并发只跑一次', async () => {
    // 1) 已安装 → 只启用，不再装包
    {
      const dataDir = makeSandbox()
      writeManagedProject(dataDir, 'feishu')
      const { manager: fake, calls } = makeConfigManager(dataDir)
      const installCalls = []
      const cm = new ChannelManager(fake)
      cm.installPlugin = async () => {
        installCalls.push('feishu')
        return true
      }
      const res = await cm.ensurePlugin('feishu')
      assertEq(res.success, true, '已安装 + 启用成功 → success')
      assertEq(res.installedNow, false, '已安装时 installedNow=false')
      assertEq(res.enabled, true, '返回 enabled=true')
      assertEq(installCalls.length, 0, '已安装时不得重复装包')
      assertDeepEq(calls.enable, ['feishu'], '启用的 openclaw 插件 id = feishu')
    }

    // 2) 缺失 → 安装 + 启用（installedNow=true）
    {
      const dataDir = makeSandbox()
      const { manager: fake, calls } = makeConfigManager(dataDir)
      const installCalls = []
      const cm = new ChannelManager(fake)
      cm.installPlugin = async (pkg, opts) => {
        installCalls.push({ pkg, force: opts?.force === true })
        writeManagedProject(dataDir, keyByPackage(pkg))
        return true
      }
      const res = await cm.ensurePlugin('feishu')
      assertEq(res.success, true, '缺失 → 安装 + 启用成功')
      assertEq(res.installedNow, true, '新装时 installedNow=true')
      assertEq(installCalls[0]?.pkg, '@openclaw/feishu', '安装的包名正确')
      assertEq(installCalls[0]?.force, false, '普通安装不传 force')
      assertDeepEq(calls.enable, ['feishu'], '安装后启用 feishu')
    }

    // 3) 安装抛错 → 可读失败，不启用
    {
      const dataDir = makeSandbox()
      const { manager: fake, calls } = makeConfigManager(dataDir)
      const cm = new ChannelManager(fake)
      cm.installPlugin = async () => {
        throw new Error('模拟安装失败')
      }
      const res = await cm.ensurePlugin('feishu')
      assertEq(res.success, false, '安装失败 → success=false')
      assert(String(res.error || '').includes('模拟安装失败'), '错误文案透出')
      assertEq(res.installed, false, '安装失败 installed=false')
      assertEq(calls.enable.length, 0, '安装失败时不得启用插件')
    }

    // 4) 安装命令成功但包实体仍缺 → 不能假成功
    {
      const dataDir = makeSandbox()
      const { manager: fake } = makeConfigManager(dataDir)
      const cm = new ChannelManager(fake)
      cm.installPlugin = async () => true
      const res = await cm.ensurePlugin('feishu')
      assertEq(res.success, false, '装后仍缺包 → 不能报 success')
      assert(String(res.error || '').includes('找不到完整插件包'), '错误说明指向包实体缺失')
    }

    // 5) 启用失败 → installed=true 但 enabled=false，错误透出
    {
      const dataDir = makeSandbox()
      writeManagedProject(dataDir, 'qqbot')
      const { manager: fake } = makeConfigManager(dataDir, {
        enableResult: { ok: false, alreadyEnabled: false, error: '插件在 plugins.deny 黑名单里' }
      })
      const cm = new ChannelManager(fake)
      cm.installPlugin = async () => true
      const res = await cm.ensurePlugin('qqbot')
      assertEq(res.success, false, '启用失败 → success=false')
      assertEq(res.installed, true, '包已安装 installed=true')
      assertEq(res.enabled, false, 'enabled=false')
      assert(String(res.error || '').includes('deny'), '启用失败原因透出')
    }

    // 6) 未知 key → 明确拒绝，不装不启用
    {
      const dataDir = makeSandbox()
      const { manager: fake, calls } = makeConfigManager(dataDir)
      const cm = new ChannelManager(fake)
      let installed = false
      cm.installPlugin = async () => {
        installed = true
        return true
      }
      const res = await cm.ensurePlugin('dingtalk')
      assertEq(res.success, false, '未知渠道（钉钉无插件）→ 拒绝')
      assert(!installed, '未知渠道不得触发安装')
      assertEq(calls.enable.length, 0, '未知渠道不得启用插件')
    }

    // 7) 并发单飞：同一渠道只装一次
    {
      const dataDir = makeSandbox()
      const { manager: fake } = makeConfigManager(dataDir)
      let installCount = 0
      const cm = new ChannelManager(fake)
      cm.installPlugin = async (pkg) => {
        installCount += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        writeManagedProject(dataDir, keyByPackage(pkg))
        return true
      }
      const [a, b] = await Promise.all([cm.ensurePlugin('feishu'), cm.ensurePlugin('feishu')])
      assertEq(installCount, 1, '并发 ensure 只执行一次安装')
      assertEq(a.success && b.success, true, '两个调用方拿到同一成功结果')
    }

    // 8) force 重装：已安装也再装一次，且带 --force
    {
      const dataDir = makeSandbox()
      writeManagedProject(dataDir, 'feishu')
      const { manager: fake } = makeConfigManager(dataDir)
      const installCalls = []
      const cm = new ChannelManager(fake)
      cm.installPlugin = async (pkg, opts) => {
        installCalls.push({ pkg, force: opts?.force === true })
        return true
      }
      const res = await cm.ensurePlugin('feishu', { force: true })
      assertEq(res.success, true, 'force 重装成功')
      assertEq(installCalls.length, 1, 'force 时即使已安装也执行安装')
      assertEq(installCalls[0]?.force, true, 'force 必须透传到 plugins install --force')
    }

    // 9) 各渠道 openclaw 插件 id 映射（enable 用错 id 会「装好但不加载」）
    {
      const cases = [
        ['weixin', 'openclaw-weixin'],
        ['qqbot', 'openclaw-qqbot'],
        ['feishu', 'feishu'],
        ['wecom', 'wecom-openclaw-plugin'],
        ['slack', 'slack']
      ]
      for (const [key, expectedPluginId] of cases) {
        const dataDir = makeSandbox()
        writeManagedProject(dataDir, key)
        const { manager: fake, calls } = makeConfigManager(dataDir)
        const cm = new ChannelManager(fake)
        cm.installPlugin = async () => true
        const res = await cm.ensurePlugin(key)
        assertEq(res.success, true, `${key} ensure 成功`)
        assertEq(calls.enable.at(-1), expectedPluginId, `${key} 启用 id 必须是 ${expectedPluginId}`)
      }
    }

    // 10) 残留空项目（安装回滚/半拷贝）：普通 install 会报 already exists，必须自动 --force
    {
      const dataDir = makeSandbox()
      writeManagedProject(dataDir, 'feishu', { withPackageJson: false })
      const { manager: fake, calls } = makeConfigManager(dataDir)
      const installCalls = []
      const cm = new ChannelManager(fake)
      cm.installPlugin = async (pkg, opts) => {
        installCalls.push({ pkg, force: opts?.force === true })
        writeManagedProject(dataDir, 'feishu') // 模拟 --force 覆盖成功
        return true
      }
      const res = await cm.ensurePlugin('feishu')
      assertEq(res.success, true, '残留目录也能一键装回')
      assertEq(res.installedNow, true, '装回后 installedNow=true')
      assertEq(installCalls[0]?.force, true, '检测到残留项目必须自动 --force')
      assertDeepEq(calls.enable, ['feishu'], '重装后启用 feishu')
    }

    // 11) --force 真的进了 CLI argv（纯函数，防止「参数没拼上」回归）
    {
      assertDeepEq(
        buildPluginInstallArgs('C:/claw/index.js', '@openclaw/feishu'),
        ['C:/claw/index.js', 'plugins', 'install', '@openclaw/feishu'],
        '普通安装 argv'
      )
      const forced = buildPluginInstallArgs('C:/claw/index.js', '@openclaw/feishu', {
        force: true
      })
      assertDeepEq(
        forced,
        ['C:/claw/index.js', 'plugins', 'install', '@openclaw/feishu', '--force'],
        'force 安装 argv 必须追加 --force'
      )
    }
    return '已装/缺失/装失败/装后仍缺/启用失败/未知 key/单飞/force/残留重装/id 映射 全部符合'
  })

  // ── P3 IPC 行为 ───────────────────────────────────────────────────────────
  await rec.check('P3', 'IPC：ensurePlugin 白名单 + 异常转失败 + presence 透传', async () => {
    const handlers = new Map()
    const ipc = { handle: (channel, fn) => handlers.set(channel, fn) }
    const ensureCalls = []
    const presence = [{ key: 'feishu', label: '飞书', installed: false }]
    const deps = {
      isPluginInstalled: () => true,
      installPlugin: async () => true,
      prepareQQBotLogin: async () => ({ success: true }),
      getChannelStatuses: () => [],
      ensureChannelPlugin: async (key, force) => {
        ensureCalls.push({ key, force })
        return { success: true, key, installed: true, installedNow: false, enabled: true }
      },
      getChannelPluginPresence: () => presence
    }
    registerChannelsIpc(ipc, deps)
    for (const channel of [
      'channels:isPluginInstalled',
      'channels:installPlugin',
      'channels:prepareQQBotLogin',
      'channels:getStatuses',
      'channels:ensurePlugin',
      'channels:getPluginPresence'
    ]) {
      assert(handlers.has(channel), `应注册 ${channel}`)
    }

    const ensureHandler = handlers.get('channels:ensurePlugin')
    const rejected = await ensureHandler(null, 'evil-pkg', false)
    assertEq(rejected.success, false, '非注册表 key 直接拒绝')
    assertEq(ensureCalls.length, 0, '被拒绝的 key 不得下沉到主进程')

    const ok = await ensureHandler(null, 'feishu', true)
    assertEq(ok.success, true, '合法 key 正常透传')
    assertDeepEq(ensureCalls[0], { key: 'feishu', force: true }, 'force 参数透传')

    // 主进程抛异常 → IPC 必须转成 {success:false}
    const handlers2 = new Map()
    registerChannelsIpc(
      { handle: (channel, fn) => handlers2.set(channel, fn) },
      { ...deps, ensureChannelPlugin: async () => { throw new Error('模拟 IPC 抛错') } }
    )
    const thrown = await handlers2.get('channels:ensurePlugin')(null, 'feishu', false)
    assertEq(thrown.success, false, '抛异常 → success=false（不能 reject 到渲染端）')
    assert(String(thrown.error || '').includes('模拟 IPC 抛错'), '异常信息透出')

    const got = await handlers.get('channels:getPluginPresence')(null)
    assertDeepEq(got, presence, 'presence 原样透传')
    return '白名单/异常/透传 正确'
  })

  // ── P4 应用侧接线（静态） ─────────────────────────────────────────────────
  await rec.check('P4', '接线：Setup/渠道页/preload/configManager 都接上统一入口', async () => {
    const setup = readFileSync(join(repoRoot, 'src', 'views', 'Setup.vue'), 'utf-8')
    const page = readFileSync(join(repoRoot, 'src', 'views', 'ChannelsPage.vue'), 'utf-8')
    const cfgSrc = readFileSync(join(repoRoot, 'electron', 'main', 'configManager.ts'), 'utf-8')
    const preload = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf-8')
    const dm = readFileSync(join(repoRoot, 'electron', 'main', 'downloadManager.ts'), 'utf-8')

    assert(/channelPluginsText/.test(setup), 'Setup 按 channelPlugins 渲染文案')
    assert(
      !/微信\/飞书\/企业微信\/钉钉\/Slack 已就绪/.test(setup),
      'Setup 不得再写「全部渠道已就绪」（飞书/钉钉都不成立）'
    )
    assert(/getPluginPresence/.test(page), '渠道页读取插件安装态')
    assert(/ensurePlugin\(/.test(page), '渠道页接上 ensurePlugin')
    assert(/groupAllowFrom/.test(page), '渠道页提供群白名单字段')
    assert(
      /feishuHadGroupAllowFrom/.test(page),
      '渠道页必须区分「原来有没有白名单字段」，否则升级后首次保存会写 [] 覆盖已有白名单'
    )
    assert(/getChannelPluginPresence/.test(dm), 'downloadManager 返回全量插件安装态')
    assert(
      /isChannelPluginInstalled\(openClawPaths\.configDir\(dataDir\), 'weixin'\)/.test(dm),
      '初始化/更新的微信安装必须用「包完整」判定（否则半拷贝会被当成已安装并跳过）'
    )
    assert(
      /isChannelPluginInstalled\(openClawPaths\.configDir\(dataDir\), 'qqbot'\)/.test(dm),
      '初始化/更新的 QQ 安装必须用「包完整」判定'
    )
    assert(/channels:ensurePlugin/.test(preload), 'preload 暴露 channels:ensurePlugin')
    assert(/channels:getPluginPresence/.test(preload), 'preload 暴露 channels:getPluginPresence')
    assert(/buildFeishuChannelPatch/.test(cfgSrc), 'configManager 用纯函数决定飞书配置写/删')
    assert(/isChannelPluginInstalled/.test(cfgSrc), 'configManager 的插件判定走注册表')
    assert(
      /pluginInstalled:\s*this\._isManagedChannelPluginInstalled\('feishu'\)/.test(cfgSrc),
      'configManager 必须把真实安装态传给纯函数（硬编码 true 会让「未安装不写」守卫失效）'
    )
    return 'Setup/渠道页/preload/configManager/downloadManager 接线齐全'
  })
} finally {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

const result = rec.toJSON({ entry: { registryPath, managerPath, ipcPath } })
writeJson(join(process.cwd(), 'test', 'accept-result-channel-plugins.json'), result)
const ok = printResult(result)
process.exit(ok ? 0 : 1)
