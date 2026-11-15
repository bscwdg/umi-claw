// test/feishu-channel-config.accept.mjs —— 飞书渠道配置补丁（纯函数）行为验收
//
// 为什么需要它：飞书配置的「写/删/跳过」决策原来埋在 configManager._syncOpenClawConfig
// 的 1300+ 行里，只能用源码字符串断言，分支正确性没有行为级证据。抽成纯函数后逐条验证：
//   B1 app.json 无飞书条目 → 不动 openclaw.json（不能删掉 channels login 向导写入的配置）
//   B2 旧字段 allowGroups 必须迁移成 groupAllowFrom（否则新版 schema 拒绝整份配置）
//   B3 显式关闭 → 删除
//   B4 缺凭证 / 插件未安装 → 跳过（绝不写会让网关起不来的半份配置）
//   B5 正常 → 写（默认策略、可选字段、群白名单归一化/清空）
//
// 用法：node test/feishu-channel-config.accept.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const bundled = bundleEntry(
  'electron/main/claw/feishuChannelConfig.ts',
  'feishu-channel-config.mjs'
)
const { buildFeishuChannelPatch } = await import(pathToFileURL(bundled).href)

const rec = new Recorder('飞书渠道配置补丁（写/删/跳过）')

const CREDS = { appId: 'cli_test', appSecret: 'secret_test' }
const BASE_UI = { enabled: true, ...CREDS }

try {
  await rec.check('B1', 'app.json 无飞书条目：不动 openclaw.json（向导写入的配置不能被删）', async () => {
    assertDeepEq(
      buildFeishuChannelPatch({ ui: undefined, existing: { appId: 'cli_x', appSecret: 's' }, pluginInstalled: true }),
      { action: 'leave' },
      'ui 缺失 → leave'
    )
    assertDeepEq(
      buildFeishuChannelPatch({ ui: undefined, existing: undefined, pluginInstalled: false }),
      { action: 'leave' },
      '双方都缺 → leave'
    )
    return 'leave 分支正确'
  })

  await rec.check('B2', '旧字段 allowGroups → groupAllowFrom 迁移（插件未安装时不能写）', async () => {
    // 插件已安装：迁移写回（旧字段会被 schema 拒绝，必须清掉）
    const migrated = buildFeishuChannelPatch({
      ui: undefined,
      existing: { appId: 'cli_x', appSecret: 's', allowGroups: ['oc_a', 'oc_b'] },
      pluginInstalled: true
    })
    assertEq(migrated.action, 'write', '插件已安装时迁移写回')
    assertEq(migrated.enablePlugin, false, 'ui 缺失时不得顺手启用插件')
    assertDeepEq(migrated.channel.groupAllowFrom, ['oc_a', 'oc_b'], 'allowGroups 值迁移到 groupAllowFrom')
    assertEq(migrated.channel.allowGroups, undefined, '旧字段必须删除')

    // 插件未安装：写 channels.feishu 会被 unknown channel id 拒绝 → 只能 leave
    const notInstalled = buildFeishuChannelPatch({
      ui: undefined,
      existing: { appId: 'cli_x', appSecret: 's', allowGroups: ['oc_a'] },
      pluginInstalled: false
    })
    assertDeepEq(notInstalled, { action: 'leave' }, '插件未安装时不写（避免整份配置被拒）')

    const noOverwrite = buildFeishuChannelPatch({
      ui: undefined,
      existing: {
        appId: 'cli_x',
        appSecret: 's',
        allowGroups: ['oc_old'],
        groupAllowFrom: ['oc_new']
      },
      pluginInstalled: true
    })
    assertDeepEq(noOverwrite.channel.groupAllowFrom, ['oc_new'], '已显式配置 groupAllowFrom 时不覆盖')
    return '迁移分支正确（含插件未安装 gate）'
  })

  await rec.check('B3', '显式关闭 → 删除 channels.feishu', async () => {
    for (const enabled of [false, undefined, 'false', 0]) {
      const patch = buildFeishuChannelPatch({
        ui: { enabled, ...CREDS },
        existing: { appId: 'cli_x', appSecret: 's' },
        pluginInstalled: true
      })
      assertDeepEq(patch, { action: 'delete' }, `enabled=${String(enabled)} → delete`)
    }
    return 'enabled !== true 一律 delete（与旧行为一致）'
  })

  await rec.check('B4', '缺凭证 / 插件未安装 → 跳过，绝不写半份配置', async () => {
    assertDeepEq(
      buildFeishuChannelPatch({ ui: { enabled: true, appId: 'cli_x' }, existing: undefined, pluginInstalled: true }),
      { action: 'skip', reason: 'missing-credentials' },
      '缺 appSecret → skip'
    )
    assertDeepEq(
      buildFeishuChannelPatch({ ui: { enabled: true, appId: '  ', appSecret: 's' }, existing: undefined, pluginInstalled: true }),
      { action: 'skip', reason: 'missing-credentials' },
      '空白 appId → skip'
    )
    assertDeepEq(
      buildFeishuChannelPatch({ ui: BASE_UI, existing: undefined, pluginInstalled: false }),
      { action: 'skip', reason: 'plugin-missing' },
      '插件未安装 → skip（否则 OpenClaw 以 unknown channel id 拒绝整份配置）'
    )
    return 'missing-credentials / plugin-missing 正确'
  })

  await rec.check('B5', '正常写入：默认策略 + 可选字段 + 群白名单归一化/清空', async () => {
    const patch = buildFeishuChannelPatch({
      ui: { ...BASE_UI, groupAllowFrom: 'oc_a, oc_b，oc_a' },
      existing: { appId: 'old', appSecret: 'old', dmPolicy: 'open' },
      pluginInstalled: true
    })
    assertEq(patch.action, 'write', '应写入')
    assertEq(patch.enablePlugin, true, '写飞书配置时同时启用插件条目')
    assertEq(patch.channel.appId, 'cli_test', 'appId 用 UI 值覆盖')
    assertEq(patch.channel.appSecret, 'secret_test', 'appSecret 用 UI 值覆盖')
    assertEq(patch.channel.dmPolicy, 'pairing', 'dmPolicy 缺省 pairing')
    assertEq(patch.channel.groupPolicy, 'allowlist', 'groupPolicy 缺省 allowlist')
    assertEq(patch.channel.requireMention, true, 'requireMention 缺省 true')
    assertDeepEq(
      patch.channel.groupAllowFrom,
      ['oc_a', 'oc_b'],
      '逗号/中文逗号/空白分隔 → 去重数组'
    )

    // 可选字段：空值不写，有值才写
    const noOptional = buildFeishuChannelPatch({ ui: BASE_UI, existing: undefined, pluginInstalled: true })
    assertEq(noOptional.channel.encryptKey, undefined, '空 encryptKey 不写')
    assertEq(noOptional.channel.verificationToken, undefined, '空 verificationToken 不写')
    const withOptional = buildFeishuChannelPatch({
      ui: { ...BASE_UI, encryptKey: 'ek', verificationToken: 'vt', requireMention: false },
      existing: undefined,
      pluginInstalled: true
    })
    assertEq(withOptional.channel.encryptKey, 'ek', 'encryptKey 透传')
    assertEq(withOptional.channel.verificationToken, 'vt', 'verificationToken 透传')
    assertEq(withOptional.channel.requireMention, false, '显式 requireMention=false 生效')

    // UI 没这个字段时保留 existing 里的群白名单（老配置不被抹）
    const preserved = buildFeishuChannelPatch({
      ui: BASE_UI,
      existing: { groupAllowFrom: ['oc_keep'] },
      pluginInstalled: true
    })
    assertDeepEq(preserved.channel.groupAllowFrom, ['oc_keep'], '未提供字段时保留已有白名单')

    // 升级场景：existing 是旧 allowGroups，UI（旧 app.json）没有 groupAllowFrom 字段
    // → 迁移后的白名单必须保留，不能被「表单默认空」覆盖成 []
    const upgraded = buildFeishuChannelPatch({
      ui: BASE_UI,
      existing: { appId: 'old', appSecret: 'old', allowGroups: ['oc_legacy'] },
      pluginInstalled: true
    })
    assertDeepEq(
      upgraded.channel.groupAllowFrom,
      ['oc_legacy'],
      '升级首次保存：迁移后的群白名单不能被空表单清空'
    )
    assertEq(upgraded.channel.allowGroups, undefined, '迁移后旧字段删除')

    // 显式空数组 = 清空（用户真的清空了表单；allowlist + 空 = 所有群都不回复）
    const cleared = buildFeishuChannelPatch({
      ui: { ...BASE_UI, groupAllowFrom: [] },
      existing: { groupAllowFrom: ['oc_keep'] },
      pluginInstalled: true
    })
    assertDeepEq(cleared.channel.groupAllowFrom, [], '显式空数组清空白名单')
    return '默认值/可选字段/归一化/保留/升级迁移/清空 全部正确'
  })

  await rec.check('B6', 'configManager 接线：决策走纯函数，不再手写飞书分支', async () => {
    const cfgSrc = readFileSync(join(repoRoot, 'electron', 'main', 'configManager.ts'), 'utf-8')
    assert(/buildFeishuChannelPatch/.test(cfgSrc), 'configManager 调用纯函数')
    assert(
      /feishuPatch\.action === 'write'/.test(cfgSrc),
      '写入分支由 action 决定'
    )
    assert(
      !/feishuCfg\.enabled\s*\)\s*\{[\s\S]{0,400}dmPolicy: feishuCfg\.dmPolicy/.test(cfgSrc),
      '不得再在手写飞书分支里拼 dmPolicy（逻辑已下沉）'
    )
    return 'configManager 接线正确'
  })
} catch (err) {
  // 单点异常也走 Recorder 记录，避免整轮无输出（与其它 accept 同口径）
  await rec.check('ERR', '套件执行异常', async () => {
    throw err
  })
}

const result = rec.toJSON({ entry: bundled })
writeJson(join(process.cwd(), 'test', 'accept-result-feishu-channel-config.json'), result)
const ok = printResult(result)
process.exit(ok ? 0 : 1)
