// test/obsidian-local-embedding.accept.mjs —— 本地 embedding 纯函数与知识体检验收
//
// 不加载真实 ONNX（那需要 54MB 模型）；覆盖可静态验证的部分：
//   - BERT WordPiece 分词：中文逐字、[CLS]/[SEP]、未知词回落 [UNK]、512 token 截断
//   - 本地模型目录缺失时给出可读错误（不静默）
//   - 知识体检：无 embedding（未配云端 key / 本地未安装）→ searchable=false + blocker
//   - 旧调用方不传 embeddingReady 时保持原语义（true）
//
// 用法：node test/obsidian-local-embedding.accept.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, assert, assertEq, bundleEntry, printResult } from './_lib.mjs'

const embeddingB = bundleEntry('resources/obsidian/local-embedding.mjs', 'obsidian-local-embedding.mjs')
const healthB = bundleEntry('electron/main/character/knowledgeHealth.ts', 'obsidian-knowledge-health.mjs')

const { encodeText, embedLocal } = await import(pathToFileURL(embeddingB).href)
const { buildKnowledgeHealth } = await import(pathToFileURL(healthB).href)

const VOCAB = [
  '[PAD]', '[UNK]', '[CLS]', '[SEP]',
  '测', '试', '服', '务', '部', '署', '周', '末', '今', '天', '天', '气',
  '##试', 'abc', '##def'
]

const recorder = new Recorder('obsidian-local-embedding')

await recorder.check('E1', '中文逐字分词 + [CLS]/[SEP]', async () => {
  const { ids } = encodeText('测试', VOCAB)
  const id = (token) => VOCAB.indexOf(token)
  assertEq(ids[0], id('[CLS]'), '首 token 为 [CLS]')
  assertEq(ids[ids.length - 1], id('[SEP]'), '末 token 为 [SEP]')
  assertEq(ids.length, 4, '测试 → [CLS] 测 试 [SEP]')
  assertEq(ids[1], id('测'))
  assertEq(ids[2], id('试'))
})

await recorder.check('E2', '英文 WordPiece + 未知词回落 [UNK]', async () => {
  const { ids } = encodeText('abcdef zzz', VOCAB)
  // abc + ##def 合成一个词；zzz 不在词表 → [UNK]
  assertEq(ids.includes(VOCAB.indexOf('abc')), true, 'abc 命中')
  assertEq(ids.includes(VOCAB.indexOf('##def')), true, '##def 命中')
  assertEq(ids.includes(VOCAB.indexOf('[UNK]')), true, '未知词回落 [UNK]')
})

await recorder.check('E3', '超过 maxLen 截断且保留 [SEP]', async () => {
  const { ids, attentionMask } = encodeText('测试测试测试测试测试', VOCAB, { maxLen: 5 })
  assertEq(ids.length, 5, '截断到 maxLen')
  assertEq(ids[0], VOCAB.indexOf('[CLS]'))
  assertEq(ids[ids.length - 1], VOCAB.indexOf('[SEP]'), '末位仍是 [SEP]')
  assertEq(attentionMask.length, 5, 'attention mask 同长')
})

await recorder.check('E4', '本地目录缺失：embedLocal 明确报错', async () => {
  let error = null
  try {
    await embedLocal(['测试'], { runtimeDir: 'Z:\\nope\\runtime', modelDir: 'Z:\\nope\\model' })
  } catch (e) {
    error = e
  }
  assert(Boolean(error), '应抛错')
  assert(/缺少运行时\/模型目录|不存在/.test(error.message), '错误信息应说明目录问题：' + error.message)
})

const baseHealth = {
  vaultPath: 'D:\\vault',
  vaultExists: true,
  obsidianEnabled: true,
  index: { chunkCount: 12, noteCount: 2, vaultPath: 'D:\\vault' },
  characterNotes: 3
}

await recorder.check('E5', '无 embedding：知识体检 searchable=false + blocker', async () => {
  const health = buildKnowledgeHealth({ ...baseHealth, embeddingReady: false })
  assertEq(health.searchable, false, '没向量模型不能算可检索')
  assertEq(health.reasons.includes('embedding-not-configured'), true, '应包含 embedding-not-configured')
})

await recorder.check('E6', 'embedding 可用：searchable=true', async () => {
  const health = buildKnowledgeHealth({ ...baseHealth, embeddingReady: true })
  assertEq(health.searchable, true)
  assertEq(health.reasons.includes('embedding-not-configured'), false)
})

await recorder.check('E7', '旧调用方不传 embeddingReady：语义不变', async () => {
  const health = buildKnowledgeHealth(baseHealth)
  assertEq(health.searchable, true, '缺省按可用处理，不破坏旧测试')
})

await recorder.check('E8', '安装目录被篡改：加载前完整性校验拒绝（不加载 ORT）', async () => {
  const { createHash } = await import('node:crypto')
  const root = mkdtempSync(join(tmpdir(), 'obsidian-local-tamper-'))
  const runtimeDir = join(root, 'runtime')
  const modelDir = join(root, 'model')
  mkdirSync(join(runtimeDir, 'node_modules/onnxruntime-node'), { recursive: true })
  mkdirSync(modelDir, { recursive: true })
  const writePkg = (dir, files) => {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content)
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      schema: 1,
      files: Object.entries(files).map(([rel, content]) => ({
        path: rel,
        sizeBytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex')
      }))
    }))
  }
  writePkg(runtimeDir, { 'node_modules/onnxruntime-node/fake.bin': 'runtime' })
  writePkg(modelDir, { 'model_quantized.onnx': 'model', 'vocab.txt': '[PAD]\n[UNK]\n[CLS]\n[SEP]\n' })
  // 篡改模型文件（大小不同/哈希不同）
  writeFileSync(join(modelDir, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\ntampered\n')
  let error = null
  try { await embedLocal(['测试'], { runtimeDir, modelDir }) } catch (e) { error = e }
  assert(Boolean(error), '篡改后应拒绝加载')
  assert(/校验失败|大小不符/.test(error.message), '错误应说明完整性失败：' + error.message)
})

const result = recorder.toJSON()
const ok = printResult(result)
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
