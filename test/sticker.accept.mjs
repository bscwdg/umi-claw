// test/sticker.accept.mjs —— 4.4 表情包库 + QQ 图片发送 + 单文件备份/导入 验收
//
// 纯 Node（零 npm 依赖，esbuild 只作为 CLI 被调用），打真源码：
//   electron/main/character/{stickerStore,stickerSender,backupBundle}.ts
// 覆盖：魔数校验 / sha256 去重 / 导入列表 / 删除归档 / json 落盘 /
//       QQ 上传 file_type=1 与 msg_type=7 payload（mock fetch，不真发）/
//       zip 导出导入 roundtrip（kv/settings/stickers 元数据）/ zip-slip / 缺 manifest / 失败回滚。
//
// 为什么自己写 zip：验收脚本零 npm 依赖，不能 import adm-zip；这里用「存储模式」手写
// 最小 zip（local header + central directory + EOCD + CRC32），正好验证备份导入能读标准 zip。

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  tmpDir,
  writeJson
} from './_lib.mjs'

const storeMod = await import(
  pathToFileURL(bundleEntry('electron/main/character/stickerStore.ts', 'sticker-store.mjs'))
)
const senderMod = await import(
  pathToFileURL(bundleEntry('electron/main/character/stickerSender.ts', 'sticker-sender.mjs'))
)
const backupMod = await import(
  pathToFileURL(
    // adm-zip 里有「运行时 require 内置模块」的写法（和 mammoth 同类），打进 ESM 会变成
    // "Dynamic require of fs is not supported"；标成 external 由 Node 按 CJS 加载。
    bundleEntry('electron/main/character/backupBundle.ts', 'sticker-backup.mjs', {
      externals: ['adm-zip']
    })
  )
)

const {
  createStickerStore,
  detectImageFormat,
  sanitizeStickerFileName,
  sanitizeStickerRecord,
  sha256Bytes,
  stickerPaths,
  STICKER_MAX_BYTES,
  STICKER_MAX_COUNT
} = storeMod
const { sendSticker, isPassiveReply, normalizeMsgSeq, QQ_STICKER_MSG_TYPE, QQ_STICKER_FILE_TYPE } =
  senderMod
const {
  createBackupBundle,
  pickKvForBackup,
  isSafeArchiveEntryName,
  backupStamp,
  BACKUP_KIND,
  BACKUP_VERSION
} = backupMod

const suite = new Recorder('sticker')
const roots = []

/** 独立的临时数据根（每轮自建、结束时统一清理，避免互相污染） */
function mkRoot(name) {
  const root = join(tmpDir, `sticker-${name}-${process.pid}-${Date.now()}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

/** 最小 PNG（魔数 + 内容由 seed 决定；够魔数校验用，不做真实解码） */
function pngBytes(seed = 1) {
  const body = Buffer.alloc(16)
  body.fill(seed % 256)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    body
  ])
}
function jpgBytes(seed = 1) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`jpeg-${seed}`, 'utf8'),
    Buffer.alloc(16, seed % 256)
  ])
}
function gifBytes(seed = 1) {
  return Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16, seed % 256)])
}
function webpBytes(seed = 1) {
  const body = Buffer.alloc(16, seed % 256)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBP', 'ascii'), body])
}

function writeTempFile(root, name, bytes) {
  mkdirSync(root, { recursive: true })
  const abs = join(root, name)
  writeFileSync(abs, bytes)
  return abs
}

/** 假 KV：模拟 CharacterKvStore 的批量读写（备份/回滚都走它） */
function makeKv(initial) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    bridge: {
      readAll: async () => Object.fromEntries(map.entries()),
      writeMany: async (entries) => {
        for (const [key, value] of Object.entries(entries ?? {})) {
          if (value === null) map.delete(key)
          else map.set(key, value)
        }
      }
    },
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    del: (key) => map.delete(key),
    snapshot: () => Object.fromEntries(map.entries())
  }
}

// ── 手写存储模式 zip（仅供「恶意/缺失 manifest」用例；正常导出走 adm-zip） ──────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8')
    const dataBuf = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? '')
    const crc = crc32(dataBuf)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const localOffset = offset
    locals.push(local, nameBuf, dataBuf)
    offset += local.length + nameBuf.length + dataBuf.length
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(dataBuf.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(localOffset, 42)
    centrals.push(central, nameBuf)
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(localBuf.length, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([localBuf, centralBuf, end])
}

function manifestJson(overrides = {}) {
  return JSON.stringify({
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    createdAt: new Date(1760000000000).toISOString(),
    createdAtMs: 1760000000000,
    platform: 'win32',
    arch: 'x64',
    ...overrides
  })
}

// ── S1 魔数 / 文件名安全 ─────────────────────────────────────────────────────
await suite.check('S1', '魔数识别只认 PNG/JPEG/GIF/WebP；文件名白名单拒绝路径穿越', async () => {
  assertEq(detectImageFormat(pngBytes(1)), 'png', 'PNG')
  assertEq(detectImageFormat(jpgBytes(1)), 'jpg', 'JPEG')
  assertEq(detectImageFormat(gifBytes(1)), 'gif', 'GIF')
  assertEq(detectImageFormat(webpBytes(1)), 'webp', 'WebP')
  assertEq(detectImageFormat(Buffer.from('hello world!!!')), null, '文本不是图片')
  assertEq(detectImageFormat(pngBytes(1).subarray(0, 6)), null, '过短拒绝')
  assertEq(sanitizeStickerFileName('abc123.png'), 'abc123.png', '合法文件名')
  assertEq(sanitizeStickerFileName('abc123.jpeg'), null, '只认 png/jpg/gif/webp 后缀')
  for (const bad of ['../evil.png', 'a/b.png', 'C:\\evil.png', '/etc/passwd.png', 'x.exe', 'ok.png.txt']) {
    assertEq(sanitizeStickerFileName(bad), null, `拒绝 ${bad}`)
  }
  assertEq(
    sanitizeStickerRecord({ id: 'abc', file: '../evil.png', format: 'png', size: 1, hash: 'f'.repeat(64) }),
    null,
    '记录里的路径穿越被丢弃'
  )
  return '魔数/文件名正确'
})

// ── S2 导入：成功/去重/非图片/超大逐条 reason ────────────────────────────────
await suite.check('S2', '导入逐条校验：成功 + sha256 去重 + 非图片 + 超大，失败带 reason', async () => {
  const root = mkRoot('import')
  const dataDir = join(root, 'data')
  const srcDir = join(root, 'src')
  const png = writeTempFile(srcDir, '开心.png', pngBytes(1))
  const dup = writeTempFile(srcDir, '开心副本.png', pngBytes(1))
  const txt = writeTempFile(srcDir, 'note.txt', Buffer.from('not an image', 'utf8'))
  const big = Buffer.concat([pngBytes(2), Buffer.alloc(STICKER_MAX_BYTES)])
  const huge = writeTempFile(srcDir, 'huge.png', big)

  const store = createStickerStore({ dataDir, now: () => 1760000000000 })
  const result = await store.import({ paths: [png, dup, txt, huge] })
  assertEq(result.imported.length, 1, '只导入 1 张')
  assertEq(result.failed.length, 3, '3 条失败')
  const reasons = result.failed.map((item) => item.reason).join('\n')
  assert(/重复/.test(reasons), '重复项有 reason')
  assert(/不是支持的图片/.test(reasons), '非图片有 reason')
  assert(/10MB/.test(reasons), '超大文件有 reason')
  const list = await store.list()
  assertEq(list.length, 1, '列表 1 张')
  assertEq(list[0].name, '开心', '名称来自文件名（去扩展名）')
  assertEq(list[0].format, 'png', '格式来自魔数')
  assertEq(list[0].enabled, true, '默认启用')
  assertEq(list[0].emotion, '', '情绪默认空')
  assertEq(list[0].tags.length, 0, '标签默认空')
  assertEq(list[0].size, pngBytes(1).length, 'size 记录实际字节数')
  assertEq(list[0].file, `${list[0].id}.png`, '文件名 = id.格式（宿主生成）')
  const metaPath = join(dataDir, 'character', 'stickers.json')
  assert(existsSync(metaPath), '元数据 json 落盘')
  const rawMeta = JSON.parse(readFileSync(metaPath, 'utf8'))
  assertEq(rawMeta.length, 1, 'json 与列表一致')
  // 同一张图重新 import 一次：去重（不重复写文件）
  const again = await store.import({ paths: [png] })
  assertEq(again.imported.length, 0, '重复导入不新增')
  assertEq(again.failed.length, 1, '重复导入返回失败 reason')
  return '导入/去重/逐条失败正确'
})

// ── S3 base64 导入 + 200 张上限 ──────────────────────────────────────────────
await suite.check('S3', 'base64 导入可用；超过 200 张上限逐条拒绝', async () => {
  const root = mkRoot('cap')
  const dataDir = join(root, 'data')
  const store = createStickerStore({ dataDir, now: () => 1760000000000 })
  const files = []
  for (let i = 0; i < STICKER_MAX_COUNT + 1; i += 1) {
    files.push({
      name: `表情-${i}.gif`,
      dataBase64: `data:image/gif;base64,${gifBytes(i + 1).toString('base64')}`
    })
  }
  const result = await store.import({ files })
  assertEq(result.imported.length, STICKER_MAX_COUNT, `最多 ${STICKER_MAX_COUNT} 张`)
  assertEq(result.failed.length, 1, '多出的 1 张失败')
  assert(/上限/.test(result.failed[0].reason), '失败 reason 说明上限')
  const list = await store.list()
  assertEq(list.length, STICKER_MAX_COUNT, '列表与上限一致')
  // 再导入任何一张都失败
  const oneMore = await store.import({ files: [{ name: 'x.gif', dataBase64: gifBytes(999).toString('base64') }] })
  assertEq(oneMore.imported.length, 0, '已在 200 张时不再导入')
  return 'base64/上限正确'
})

// ── S4 update 消毒 + 新实例读回 ──────────────────────────────────────────────
await suite.check('S4', 'update 只改白名单字段并消毒；换实例从磁盘读回', async () => {
  const root = mkRoot('update')
  const dataDir = join(root, 'data')
  const src = writeTempFile(join(root, 'src'), 'a.png', pngBytes(3))
  const store = createStickerStore({ dataDir, now: () => 1760000000000 })
  const imported = await store.import({ paths: [src] })
  const id = imported.imported[0].id
  const updated = await store.update(id, {
    name: '  笑死{哈哈}  ',
    emotion: ' HAPPY ',
    tags: [' 猫猫 ', '猫猫', '', 'meme', '#tag'],
    enabled: false
  })
  assertEq(updated.name, '笑死 哈哈', '名称去花括号/压空白')
  assertEq(updated.emotion, 'happy', '情绪小写化')
  assertEq(updated.tags.join(','), '猫猫,meme,tag', '标签去重/去空/去井号')
  assertEq(updated.enabled, false, 'enabled 生效')
  assertEq(updated.hash.length, 64, 'hash 不被 patch 改坏')
  // 新实例（模拟重启）从磁盘读：数据一致
  const store2 = createStickerStore({ dataDir })
  const reloaded = await store2.get(id)
  assertEq(reloaded.name, '笑死 哈哈', '换实例读回名称')
  assertEq(reloaded.enabled, false, '换实例读回 enabled')
  assertEq(reloaded.emotion, 'happy', '换实例读回情绪')
  return 'update/持久化正确'
})

// ── S5 删除 = 归档（不硬删）+ 情绪挑选 ──────────────────────────────────────
await suite.check('S5', '删除归档到 stickers-archive；pickByEmotion 跳过未启用/冷却', async () => {
  const root = mkRoot('delete')
  const dataDir = join(root, 'data')
  const srcDir = join(root, 'src')
  const store = createStickerStore({ dataDir, now: () => 1760000000000 })
  const imported = await store.import({
    paths: [writeTempFile(srcDir, 'a.png', pngBytes(11)), writeTempFile(srcDir, 'b.png', pngBytes(12))]
  })
  assertEq(imported.imported.length, 2, '两张导入成功')
  const [first, second] = imported.imported
  await store.update(first.id, { emotion: 'happy' })
  await store.update(second.id, { emotion: 'happy' })
  // 第一张用得多 → 第二张优先；再禁用第二张 → 只能选第一张
  await store.markUsed(first.id, 1760000000001)
  let picked = await store.pickByEmotion('HAPPY')
  assertEq(picked.id, second.id, '优先用得少的那张')
  await store.update(second.id, { enabled: false })
  picked = await store.pickByEmotion('happy')
  assertEq(picked.id, first.id, '未启用的不参与挑选')

  const removed = await store.remove(second.id)
  assert(existsSync(removed.archivedTo), '归档目录已创建')
  const archivedFiles = readFileSync(join(removed.archivedTo, 'stickers.json'), 'utf8')
  assert(archivedFiles.includes(second.id), '归档目录保留元数据（可找回）')
  assert(existsSync(join(removed.archivedTo, second.file)), '归档目录保留原图')
  assert(!existsSync(join(dataDir, 'character', 'stickers', second.file)), '原目录已移除图')
  const remaining = await store.list()
  assertEq(remaining.length, 1, '列表只剩 1 张')
  assertEq(remaining[0].id, first.id, '剩下的是第一张')
  return '归档删除/情绪挑选正确'
})

// ── S6 QQ 主动发送：上传 file_type=1 → 发 msg_type=7 ────────────────────────
await suite.check('S6', 'QQ 主动发图：上传 file_type=1，发送 msg_type=7 + media.file_info', async () => {
  const root = mkRoot('send')
  const file = writeTempFile(join(root, 'src'), 's.png', pngBytes(21))
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-sticker' }) }
    }
    if (String(url).endsWith('/files')) {
      return { ok: true, status: 200, json: async () => ({ file_info: 'fi_sticker_1' }) }
    }
    return { ok: true, status: 200, json: async () => ({ id: 'msg_sticker_1' }) }
  }
  const result = await sendSticker({
    creds: { appId: 'sticker-app-active', clientSecret: 's'.repeat(32), openid: 'openid-1' },
    filePath: file,
    format: 'png',
    fileName: 's.png',
    fetchImpl
  })
  assertEq(result.ok, true, '发送成功')
  assertEq(result.messageId, 'msg_sticker_1', '返回 message id')
  const uploadCall = calls.find((call) => call.url.endsWith('/files'))
  assert(uploadCall, '有上传调用')
  assert(uploadCall.init.body instanceof FormData, '上传用 multipart FormData')
  assertEq(String(uploadCall.init.body.get('file_type')), String(QQ_STICKER_FILE_TYPE), 'file_type=1')
  assertEq(String(uploadCall.init.body.get('srv_send_msg')), 'false', '只上传不自动发')
  assert(uploadCall.init.body.get('file'), '带 file')
  const sendCall = calls.find((call) => call.url.endsWith('/messages'))
  const payload = JSON.parse(sendCall.init.body)
  assertEq(payload.msg_type, QQ_STICKER_MSG_TYPE, 'msg_type=7')
  assertEq(payload.media.file_info, 'fi_sticker_1', '带 file_info')
  assertEq('msg_id' in payload, false, '主动消息不带 msg_id')
  assertEq('msg_seq' in payload, false, '主动消息不带 msg_seq')
  assert(String(sendCall.init.headers.Authorization).startsWith('QQBot '), '鉴权头')
  return '主动发图链路正确'
})

// ── S7 QQ 被动回复：msg_id/event_id + msg_seq ────────────────────────────────
await suite.check('S7', 'QQ 被动回复：msgId/eventId + msg_seq，payload 正确', async () => {
  const root = mkRoot('passive')
  const file = writeTempFile(join(root, 'src'), 'j.jpg', jpgBytes(31))
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-passive' }) }
    }
    if (String(url).endsWith('/files')) {
      return { ok: true, status: 200, json: async () => ({ file_info: 'fi_passive' }) }
    }
    return { ok: true, status: 200, json: async () => ({ id: 'msg_passive' }) }
  }
  assertEq(isPassiveReply({}), false, '无 id = 主动')
  assertEq(isPassiveReply({ msgId: 'm1' }), true, 'msgId = 被动')
  assertEq(isPassiveReply({ eventId: 'e1' }), true, 'eventId = 被动')
  assertEq(normalizeMsgSeq(0), 1, '非法 seq 回落 1')
  assertEq(normalizeMsgSeq(3), 3, '合法 seq 保留')

  const byMsg = await sendSticker({
    creds: { appId: 'sticker-app-passive', clientSecret: 's'.repeat(32), openid: 'openid-2' },
    filePath: file,
    format: 'jpg',
    msgId: 'msg_001',
    msgSeq: 3,
    fetchImpl
  })
  assertEq(byMsg.ok, true, 'msg_id 被动回复成功')
  let payload = JSON.parse(calls.find((call) => call.url.endsWith('/messages')).init.body)
  assertEq(payload.msg_id, 'msg_001', '带 msg_id')
  assertEq(payload.msg_seq, 3, '带 msg_seq')
  assertEq(payload.msg_type, 7, 'msg_type=7')

  calls.length = 0
  const byEvent = await sendSticker({
    creds: { appId: 'sticker-app-passive', clientSecret: 's'.repeat(32), openid: 'openid-2' },
    filePath: file,
    format: 'jpg',
    eventId: 'event_001',
    fetchImpl
  })
  assertEq(byEvent.ok, true, 'event_id 被动回复成功')
  payload = JSON.parse(calls.find((call) => call.url.endsWith('/messages')).init.body)
  assertEq(payload.event_id, 'event_001', '带 event_id')
  assertEq(payload.msg_seq, 1, '缺省 seq=1')
  return '被动回复 payload 正确'
})

// ── S8 发送失败：明确 reason，不抛异常 ──────────────────────────────────────
await suite.check('S8', '发送失败返回明确 reason（无凭据/文件丢失/格式不符/HTTP 失败）', async () => {
  const root = mkRoot('send-fail')
  const file = writeTempFile(join(root, 'src'), 's.png', pngBytes(41))
  const noCreds = await sendSticker({ creds: null, filePath: file })
  assertEq(noCreds.ok, false, '无凭据失败')
  assertEq(noCreds.reason, 'no-creds', 'reason=no-creds')

  const missing = await sendSticker({
    creds: { appId: 'a', clientSecret: 'b', openid: 'c' },
    filePath: join(root, 'nope.png')
  })
  assertEq(missing.reason, 'file-missing', 'reason=file-missing')

  const mismatch = await sendSticker({
    creds: { appId: 'a', clientSecret: 'b', openid: 'c' },
    filePath: file,
    format: 'gif'
  })
  assertEq(mismatch.reason, 'format-mismatch', '记录格式与魔数不符 → 拒绝')

  const httpFail = await sendSticker({
    creds: { appId: 'sticker-app-fail', clientSecret: 'c'.repeat(32), openid: 'openid-3' },
    filePath: file,
    format: 'png',
    fetchImpl: async (url) => {
      if (String(url).includes('getAppAccessToken')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      }
      return { ok: false, status: 400, json: async () => ({ message: 'bad request' }) }
    }
  })
  assertEq(httpFail.ok, false, 'HTTP 失败不抛异常')
  assertEq(httpFail.reason, 'upload-failed', '上传失败 reason')
  assert(/400/.test(httpFail.detail ?? ''), 'detail 带 HTTP 状态')
  return '失败 reason 正确'
})

// ── S9 zip 导出：白名单 kv / 人格 / 日记 / 表情包 ────────────────────────────
await suite.check('S9', 'zip 导出：manifest + kv 白名单 + persona + memory + stickers', async () => {
  const root = mkRoot('export')
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'config', '.openclaw', 'workspace-feiyu')
  mkdirSync(join(workspaceDir, 'memory'), { recursive: true })
  writeFileSync(join(workspaceDir, 'SOUL.md'), '# 灵魂\n用户手写内容\n', 'utf8')
  writeFileSync(join(workspaceDir, 'AGENTS.md'), '# AGENTS\n用户内容\n', 'utf8')
  writeFileSync(join(workspaceDir, 'memory', '2026-01-02.md'), '今天的日记\n', 'utf8')
  writeFileSync(join(workspaceDir, 'memory', 'not-a-date.md'), '非日记文件\n', 'utf8')

  const kv = makeKv({
    'fish:v2:settings': JSON.stringify({ enabled: true, relationship: { address: '宝宝' } }),
    'fish:v2:state': JSON.stringify({ stage: 2, familiarity: 40 }),
    'fish:v2:day:2026-01-02': JSON.stringify({ pat: 1 }),
    'fish:v2:meta': JSON.stringify({ version: 1, days: ['2026-01-02'], lifeDays: [] }),
    'fish:v2:chatgen': JSON.stringify({ gen: 3 }),
    'fish:v2:petAppearance': JSON.stringify({ file: 'local.png' }),
    'fish:v2:apiKey': 'sk-test-must-not-be-backed-up'
  })
  const stickerStore = createStickerStore({ dataDir })
  const srcDir = join(root, 'src')
  const imported = await stickerStore.import({ paths: [writeTempFile(srcDir, '开心.png', pngBytes(51))] })
  assertEq(imported.imported.length, 1, '预置 1 张表情包')

  const zipPath = join(root, 'character-backup.zip')
  const bundle = createBackupBundle({ dataDir, workspaceDir, kv: kv.bridge, now: () => 1760000000000 })
  const result = await bundle.exportTo(zipPath)
  assert(existsSync(zipPath), 'zip 已生成')
  assertEq(result.path, zipPath, '返回路径')
  assert(result.bytes > 0, 'zip 非空')
  assertEq(result.counts.kv, 4, 'kv 只含 settings/state/meta/day（不含 chatgen/petAppearance/apiKey）')
  assertEq(result.counts.persona, 2, 'SOUL + AGENTS')
  assertEq(result.counts.memory, 1, '只打包日期命名的日记')
  assertEq(result.counts.stickers, 1, '表情包 1 张')
  // 直接读 zip 字节层面确认 manifest 存在（存储/压缩都可能，只查魔数与文件尾不可靠，交给导入用例）
  const exported = readFileSync(zipPath)
  assertEq(exported.subarray(0, 2).toString('ascii'), 'PK', '是标准 zip')
  return `导出正确（${result.bytes} 字节）`
})

// ── S10 zip 导入 roundtrip：kv/persona/memory/stickers 恢复 + 导入前备份 ──────
await suite.check('S10', 'zip roundtrip：恢复 kv/人格/日记/表情包；导入前自动备份；不含密钥', async () => {
  const root = mkRoot('roundtrip')
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'config', '.openclaw', 'workspace-feiyu')
  mkdirSync(join(workspaceDir, 'memory'), { recursive: true })
  writeFileSync(join(workspaceDir, 'SOUL.md'), '# 灵魂 v1\n', 'utf8')
  writeFileSync(join(workspaceDir, 'memory', '2026-02-03.md'), '二月三日的日记\n', 'utf8')
  const kv = makeKv({
    'fish:v2:settings': JSON.stringify({ enabled: true, relationship: { address: '宝宝' } }),
    'fish:v2:state': JSON.stringify({ stage: 3, familiarity: 66 }),
    'fish:v2:day:2026-02-03': JSON.stringify({ pat: 2 })
  })
  const stickerStore = createStickerStore({ dataDir })
  const srcDir = join(root, 'src')
  const imported = await stickerStore.import({ paths: [writeTempFile(srcDir, '开心.png', pngBytes(61))] })
  const stickerId = imported.imported[0].id
  await stickerStore.update(stickerId, { emotion: 'happy', tags: ['猫猫'] })

  const zipPath = join(root, 'backup.zip')
  const bundle = createBackupBundle({ dataDir, workspaceDir, kv: kv.bridge, now: () => 1760000000000 })
  await bundle.exportTo(zipPath)

  // 破坏现有数据：设置改成停用、删人格、删日记、删表情包
  kv.set('fish:v2:settings', JSON.stringify({ enabled: false }))
  kv.del('fish:v2:state')
  rmSync(join(workspaceDir, 'SOUL.md'), { force: true })
  rmSync(join(workspaceDir, 'memory', '2026-02-03.md'), { force: true })
  await stickerStore.remove(stickerId)
  assertEq((await stickerStore.list()).length, 0, '导入前表情包已清空')

  const restored = await bundle.importFrom(zipPath)
  const settings = JSON.parse(kv.get('fish:v2:settings'))
  assertEq(settings.enabled, true, 'settings 恢复')
  assertEq(settings.relationship.address, '宝宝', 'settings 嵌套字段恢复')
  assertEq(JSON.parse(kv.get('fish:v2:state')).stage, 3, 'state 恢复')
  assertEq(JSON.parse(kv.get('fish:v2:day:2026-02-03')).pat, 2, '按日 day 恢复')
  assertEq(readFileSync(join(workspaceDir, 'SOUL.md'), 'utf8'), '# 灵魂 v1\n', '人格文件恢复')
  assert(existsSync(join(workspaceDir, 'memory', '2026-02-03.md')), '日记恢复')
  const list = await stickerStore.list()
  assertEq(list.length, 1, '表情包恢复')
  assertEq(list[0].id, stickerId, '表情包 id 一致')
  assertEq(list[0].emotion, 'happy', '表情包情绪元数据恢复')
  assertEq(list[0].tags.join(','), '猫猫', '表情包标签恢复')
  assert(existsSync(join(dataDir, 'character', 'stickers', list[0].file)), '表情包文件恢复')
  assertEq(restored.restartRequired, true, 'kv 恢复后需重启让 manager 内存态一致')
  assert(existsSync(restored.backupPath), '导入前自动备份 zip 存在')
  assertEq(restored.restored.kv.length, 3, '恢复 3 个 kv 键')
  return 'roundtrip 正确'
})

// ── S11 zip-slip 防护 ───────────────────────────────────────────────────────
await suite.check('S11', 'zip-slip：越界条目整包拒绝，不写任何外部文件', async () => {
  const root = mkRoot('slip')
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'config', '.openclaw', 'workspace-feiyu')
  mkdirSync(workspaceDir, { recursive: true })
  const kv = makeKv({})
  const bundle = createBackupBundle({ dataDir, workspaceDir, kv: kv.bridge, now: () => 1760000000000 })
  for (const evil of ['../evil.txt', 'character/../../evil.txt', 'C:/evil.txt', '/abs-evil.txt', 'a\\\\b.txt']) {
    const zipPath = join(root, `slip-${Math.abs(crc32(Buffer.from(evil)))}.zip`)
    writeFileSync(
      zipPath,
      makeZip([
        { name: 'manifest.json', data: manifestJson() },
        { name: 'character/kv.json', data: JSON.stringify({ 'fish:v2:settings': '{}' }) },
        { name: evil, data: 'pwned' }
      ])
    )
    let error = null
    try {
      await bundle.importFrom(zipPath)
    } catch (e) {
      error = e
    }
    assert(error, `恶意条目应被拒绝：${evil}`)
    assert(/zip-slip|路径非法|越界/.test(String(error.message)), `拒绝原因可读：${evil}`)
  }
  // 任何变体都不得在 dataDir 之外落盘
  assert(!existsSync(join(root, 'evil.txt')), '根目录没有 evil.txt')
  assert(!existsSync(join(dataDir, 'evil.txt')), 'dataDir 没有 evil.txt')
  assert(!existsSync(join(root, 'data', 'config', 'evil.txt')), 'workspace 上级没有 evil.txt')
  assertEq(isSafeArchiveEntryName('../x.png'), false, '工具函数拒绝 ../')
  assertEq(isSafeArchiveEntryName('stickers/a.png'), true, '工具函数接受正常路径')
  // 另一个维度：manifest 正常但缺 manifest 也要拒绝
  const noManifest = join(root, 'no-manifest.zip')
  writeFileSync(
    noManifest,
    makeZip([{ name: 'character/kv.json', data: JSON.stringify({ 'fish:v2:settings': '{}' }) }])
  )
  let noManifestError = null
  try {
    await bundle.importFrom(noManifest)
  } catch (e) {
    noManifestError = e
  }
  assert(noManifestError, '缺 manifest 必须拒绝')
  assert(/manifest/.test(String(noManifestError.message)), '缺 manifest 的提示可读')
  // 版本不支持
  const badVersion = join(root, 'bad-version.zip')
  writeFileSync(
    badVersion,
    makeZip([
      { name: 'manifest.json', data: manifestJson({ version: BACKUP_VERSION + 1 }) },
      { name: 'character/kv.json', data: '{}' }
    ])
  )
  let versionError = null
  try {
    await bundle.importFrom(badVersion)
  } catch (e) {
    versionError = e
  }
  assert(versionError, '版本不支持必须拒绝')
  assert(/版本/.test(String(versionError.message)), '版本提示可读')
  return 'zip-slip/缺 manifest/版本校验正确'
})

// ── S12 导入失败回滚：kv/人格/日记回到导入前 ─────────────────────────────────
await suite.check('S12', '恢复中途失败 → 已恢复的 kv/人格/日记回滚，现有数据不被写坏', async () => {
  const root = mkRoot('rollback')
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'config', '.openclaw', 'workspace-feiyu')
  mkdirSync(join(workspaceDir, 'memory'), { recursive: true })
  writeFileSync(join(workspaceDir, 'SOUL.md'), '旧人格\n', 'utf8')
  const kv = makeKv({
    'fish:v2:settings': JSON.stringify({ enabled: true, relationship: { address: '旧称呼' } })
  })
  const bundle = createBackupBundle({ dataDir, workspaceDir, kv: kv.bridge, now: () => 1760000000000 })

  // 准备一个正常备份包（用临时目录导出，避免影响被测 dataDir）
  const srcRoot = join(root, 'src-data')
  const srcWorkspace = join(srcRoot, 'config', '.openclaw', 'workspace-feiyu')
  mkdirSync(join(srcWorkspace, 'memory'), { recursive: true })
  writeFileSync(join(srcWorkspace, 'SOUL.md'), '新人格\n', 'utf8')
  writeFileSync(join(srcWorkspace, 'memory', '2026-03-04.md'), '新日记\n', 'utf8')
  const srcKv = makeKv({
    'fish:v2:settings': JSON.stringify({ enabled: false, relationship: { address: '新称呼' } })
  })
  const srcBundle = createBackupBundle({
    dataDir: srcRoot,
    workspaceDir: srcWorkspace,
    kv: srcKv.bridge,
    now: () => 1760000000000
  })
  const zipPath = join(root, 'ok.zip')
  await srcBundle.exportTo(zipPath)

  // 让表情包元数据写盘必失败：把 <character>/stickers.json 做成目录
  mkdirSync(join(dataDir, 'character', 'stickers.json'), { recursive: true })

  let error = null
  try {
    await bundle.importFrom(zipPath)
  } catch (e) {
    error = e
  }
  assert(error, '导入应失败')
  assert(/回滚/.test(String(error.message)), '失败信息说明已回滚')
  assertEq(
    JSON.parse(kv.get('fish:v2:settings')).relationship.address,
    '旧称呼',
    'kv 回滚到导入前'
  )
  assertEq(readFileSync(join(workspaceDir, 'SOUL.md'), 'utf8'), '旧人格\n', '人格文件回滚')
  assert(!existsSync(join(workspaceDir, 'memory', '2026-03-04.md')), '导入新增的日记被回滚删除')
  return '失败回滚正确'
})

const result = suite.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-sticker.json'), result)
for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}
if (!ok) process.exit(1)
