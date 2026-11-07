#!/usr/bin/env node
// scripts/qqbot-voice-send.cjs —— 给 QQBot C2C 用户发 SILK 语音条（已实测配方）
//
// 用法：
//   node scripts/qqbot-voice-send.cjs <silkFile> [openid] [msg_id] [msg_seq]
//
// 关键点（2026-11-07 两次实测）：
//   1. 上传必须用 file_data（base64）；url/base64:// / data: URI 会 40093010
//   2. 发送只认 msg_type=7 + media.file_info，不带 content / message_reference
//   3. Authorization: QQBot <token>（不是 Bearer）
//   4. clientSecret 优先读 credential-backup/current.json（32 位），配置里的 16 位不可靠
//
// 环境变量（都可不设）：
//   CLAW_DATA_DIR           覆盖 data 目录
//   QQBOT_APP_ID / QQBOT_CLIENT_SECRET   覆盖凭据
//   QQBOT_OPENID            覆盖 openid
//   QQBOT_CREDENTIAL_FILE   指定 credential-backup/current.json
//   QQBOT_API_BASE          默认 https://api.sgroup.qq.com
//   QQBOT_VOICE_DRY_RUN=1   只校验文件/凭据，不发网络请求
//
// 退出码：0 成功；1 失败。

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_API_BASE = 'https://api.sgroup.qq.com'
const SILK_MAGIC = Buffer.from('#!SILK_V3', 'ascii')

function fail(message) {
  throw new Error(message)
}

function repoRoot() {
  return path.resolve(__dirname, '..')
}

function resolveDataDir() {
  const fromEnv = process.env.CLAW_DATA_DIR
  if (fromEnv) return path.resolve(fromEnv)
  const candidates = [
    path.join(repoRoot(), 'data'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'UmiClaw', 'data') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Umi Claw', 'data') : null
  ].filter(Boolean)
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'config', '.openclaw'))) return dir
  }
  fail(
    '找不到 data 目录：请设置 CLAW_DATA_DIR（例如 D:\\work2026\\files\\claw-desktop\\data）'
  )
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`读取${label}失败（${file}）：${error.message}`)
  }
}

function resolveCredentials(dataDir) {
  const explicitFile =
    process.env.QQBOT_CREDENTIAL_FILE ||
    path.join(
      dataDir,
      'config',
      '.openclaw',
      'qqbot',
      'data',
      'credential-backup',
      'current.json'
    )
  let appId = String(process.env.QQBOT_APP_ID || '').trim()
  let clientSecret = String(process.env.QQBOT_CLIENT_SECRET || '').trim()
  const sources = []
  const addSource = (value) => {
    if (value && !sources.includes(value)) sources.push(value)
  }
  if (appId) addSource('env:QQBOT_APP_ID')
  if (clientSecret) addSource('env:QQBOT_CLIENT_SECRET')

  if (fs.existsSync(explicitFile)) {
    const cred = readJson(explicitFile, ' credential-backup')
    if (!appId && cred.appId) {
      appId = String(cred.appId).trim()
      addSource(explicitFile)
    }
    if (!clientSecret && cred.clientSecret) {
      clientSecret = String(cred.clientSecret).trim()
      addSource(explicitFile)
    }
  }

  if (!appId || !clientSecret) {
    // 最后兜底：openclaw.json 的 channels.qqbot（旧版本可能是 16 位占位值）
    const oc = path.join(dataDir, 'config', '.openclaw', 'openclaw.json')
    if (fs.existsSync(oc)) {
      const cfg = readJson(oc, 'openclaw.json')
      const qq = cfg && cfg.channels && cfg.channels.qqbot
      if (qq) {
        if (!appId && qq.appId) {
          appId = String(qq.appId).trim()
          sources.push(oc + ':channels.qqbot.appId')
        }
        if (!clientSecret && qq.clientSecret) {
          clientSecret = String(qq.clientSecret).trim()
          sources.push(oc + ':channels.qqbot.clientSecret')
          console.warn(
            '[warn] 用的是 openclaw.json 里的 clientSecret；旧版本可能只有 16 位，' +
              '请优先用 credential-backup/current.json 的 32 位值'
          )
        }
      }
    }
  }
  if (!appId || !clientSecret) {
    fail(
      `找不到 QQBot 凭据；请在 App 里扫码登录 QQBot，或设置 QQBOT_APP_ID/QQBOT_CLIENT_SECRET（参考 ${explicitFile}）`
    )
  }
  return { appId, clientSecret, source: sources.join(' + ') || 'unknown' }
}

function resolveOpenId(dataDir, explicit) {
  // 显式参数最优先：避免环境里残留 QQBOT_OPENID 时把消息发错人
  if (explicit) return String(explicit).trim()
  const env = String(process.env.QQBOT_OPENID || '').trim()
  if (env) return env
  const usersFile = path.join(
    dataDir,
    'config',
    '.openclaw',
    'qqbot',
    'data',
    'known-users.json'
  )
  if (!fs.existsSync(usersFile)) {
    fail('没有 openid 参数，也找不到 known-users.json；请显式传 openid')
  }
  const list = readJson(usersFile, 'known-users.json')
  const users = Array.isArray(list) ? list : []
  const last = users.length ? users[users.length - 1] : null
  if (!last || !last.openid) fail('known-users.json 里没有 openid；请显式传 openid')
  console.warn(`[warn] 未显式传 openid，使用 known-users 最后一条：${last.openid}`)
  return String(last.openid)
}

function readSilk(file) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) fail(`SILK 文件不存在：${abs}`)
  const data = fs.readFileSync(abs)
  if (data.length < 10) fail(`SILK 文件过短：${abs}`)
  const hasPrefix = data[0] === 0x02 && data.subarray(1, 10).equals(SILK_MAGIC)
  if (!hasPrefix) {
    fail(
      '不是 QQBot 可用的 SILK：需要 0x02 + "#!SILK_V3" 头；' +
        '请先运行 node scripts/qqbot-voice-make-silk.mjs <mp3|wav> <out.silk>'
    )
  }
  return { abs, data }
}

function parseSeq(value) {
  if (value === undefined || value === '') return 1
  const seq = Number(value)
  if (!Number.isInteger(seq) || seq < 1) fail(`msg_seq 必须是正整数，收到：${value}`)
  return seq
}

async function fetchJson(url, init, label) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000)
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // 保留原文给错误信息
  }
  if (!res.ok) {
    fail(`${label}失败 HTTP ${res.status}：${String(text).slice(0, 400)}`)
  }
  if (!json) fail(`${label}返回不是 JSON：${String(text).slice(0, 200)}`)
  return json
}

async function getToken(appId, clientSecret) {
  const json = await fetchJson(
    'https://bots.qq.com/app/getAppAccessToken',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret })
    },
    '获取 access_token'
  )
  if (!json.access_token) fail(`获取 token 失败：${JSON.stringify(json).slice(0, 300)}`)
  return String(json.access_token)
}

function parseArgs(argv) {
  const out = { silk: '', openid: '', msgId: '', seq: undefined, dryRun: false, help: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--openid') out.openid = String(argv[++i] || '')
    else if (arg === '--msg-id') out.msgId = String(argv[++i] || '')
    else if (arg === '--seq') out.seq = argv[++i]
    else positional.push(arg)
  }
  out.silk = positional[0] || ''
  // 兼容位置参数；但 PowerShell 5.1 会丢 ""，所以推荐用 --openid/--msg-id/--seq
  if (!out.openid && positional[1] !== undefined) out.openid = positional[1]
  if (!out.msgId && positional[2] !== undefined) out.msgId = positional[2]
  if (out.seq === undefined && positional[3] !== undefined) out.seq = positional[3]
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.silk) {
    console.log(
      '用法: node scripts/qqbot-voice-send.cjs <silkFile> [openid] [msg_id] [msg_seq]'
    )
    console.log('  命名参数: --openid <id> --msg-id <id> --seq <n> [--dry-run]')
    console.log('  例: node scripts/qqbot-voice-send.cjs media/voice.silk --openid <openid> --dry-run')
    console.log(
      '  例: node scripts/qqbot-voice-send.cjs media/voice.silk --openid <openid> --msg-id <id> --seq 1'
    )
    console.log('环境变量: CLAW_DATA_DIR / QQBOT_APP_ID / QQBOT_CLIENT_SECRET / QQBOT_OPENID')
    console.log('          QQBOT_CREDENTIAL_FILE / QQBOT_API_BASE / QQBOT_VOICE_DRY_RUN / FFMPEG')
    return
  }
  const silk = readSilk(args.silk)
  const dataDir = resolveDataDir()
  const cred = resolveCredentials(dataDir)
  const openid = resolveOpenId(dataDir, args.openid)
  const msgId = String(args.msgId || '').trim()
  const seq = parseSeq(args.seq)
  const apiBase = (process.env.QQBOT_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '')
  const dryRun = args.dryRun || process.env.QQBOT_VOICE_DRY_RUN === '1'

  console.log(`[info] dataDir: ${dataDir}`)
  console.log(`[info] 凭据来源: ${cred.source}（appId=${cred.appId}）`)
  console.log(`[info] openid: ${openid}`)
  console.log(`[info] SILK: ${silk.abs}（${silk.data.length} bytes）`)
  console.log(`[info] msg_id: ${msgId || '（无，主动消息）'}，msg_seq: ${seq}`)
  if (dryRun) {
    console.log('[dry-run] 文件/凭据校验通过，没有请求 QQ，也没有发消息')
    return
  }

  const token = await getToken(cred.appId, cred.clientSecret)
  const upload = await fetchJson(
    `${apiBase}/v2/users/${encodeURIComponent(openid)}/files`,
    {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file_type: 3,
        file_data: silk.data.toString('base64'),
        srv_send_msg: false
      })
    },
    '上传语音文件'
  )
  const fileInfo = upload.file_info || upload.file_uuid
  if (!fileInfo) {
    fail(`上传返回没有 file_info/file_uuid：${JSON.stringify(upload).slice(0, 300)}`)
  }
  console.log(`[info] upload ok: file_info=${String(fileInfo).slice(0, 60)}...`)

  const body = {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: seq
  }
  if (msgId) body.msg_id = msgId
  const send = await fetchJson(
    `${apiBase}/v2/users/${encodeURIComponent(openid)}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    },
    '发送语音条'
  )
  console.log(`[ok] send: ${JSON.stringify(send).slice(0, 300)}`)
  console.log('[ok] 请求体为 msg_type=7 + media.file_info；对方应看到语音条')
}

main().catch((error) => {
  console.error(`[error] ${error.message}`)
  process.exit(1)
})
