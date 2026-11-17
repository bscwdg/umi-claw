#!/usr/bin/env node
// local-selftest.mjs —— 本地 embedding 一次性自检（由主进程用便携 Node 拉起）。
//
// 用途：安装完成后 / 「测试连通」时，真实加载运行时+模型，编码“测试”，断言 512 维。
// 成功输出单行 JSON：{ ok: true, dim, ms }
// 失败输出单行 JSON：{ ok: false, error }，退出码 1。
//
// env：OBS_EMBEDDING_LOCAL_RUNTIME_DIR / OBS_EMBEDDING_LOCAL_MODEL_DIR

import { embedLocal } from './local-embedding.mjs'

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const started = Date.now()
try {
  const runtimeDir = process.env.OBS_EMBEDDING_LOCAL_RUNTIME_DIR
  const modelDir = process.env.OBS_EMBEDDING_LOCAL_MODEL_DIR
  if (!runtimeDir || !modelDir) throw new Error('缺少 OBS_EMBEDDING_LOCAL_RUNTIME_DIR / OBS_EMBEDDING_LOCAL_MODEL_DIR')
  const [vec] = await embedLocal(['测试'], { runtimeDir, modelDir }, 'search_document')
  if (!vec || !vec.length) throw new Error('模型没有返回向量')
  out({ ok: true, dim: vec.length, ms: Date.now() - started })
} catch (error) {
  out({ ok: false, error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}
