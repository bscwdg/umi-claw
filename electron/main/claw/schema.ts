// electron/main/claw/schema.ts —— 读 OpenClaw 各数据库的 schema 版本
//
// 为什么单独拆出来：更新流程的「数据有没有被 doctor 迁移过」是回滚安全性的唯一判据，
// 而它只需要读 SQLite 文件头的 4 个字节；与网关状态机无关，纯函数便于单独验证。

import { closeSync, existsSync, openSync, readSync, readdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { openClawPaths } from '../openClawPaths'

/** SQLite 文件头里 `PRAGMA user_version` 的偏移（4 字节大端 uint32） */
const SQLITE_USER_VERSION_OFFSET = 60

/** 单个 OpenClaw 数据库的 schema 版本 */
export interface SchemaVersionEntry {
  /** 相对 config/.openclaw 的路径（正斜杠），便于日志与断言定位 */
  file: string
  /** `PRAGMA user_version`；读不到时为 null */
  version: number | null
}

/**
 * 读 SQLite 文件头 offset 60 处的大端 uint32，即 `PRAGMA user_version`。
 *
 * 不引 sqlite 依赖：这里只需要「版本号变没变」，读 4 个字节就够；
 * 真正 open 一次库反而会和 doctor / 网关抢锁。
 *
 * 读不到（文件不存在 / 被独占 / 不是 SQLite）返回 null，调用方按「未知」处理 ——
 * 绝不要把「读不到」当成「没变」，那会让回滚安全性判断失效。
 */
function readUserVersion(file: string): number | null {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(4)
      if (readSync(fd, buf, 0, 4, SQLITE_USER_VERSION_OFFSET) !== 4) return null
      return buf.readUInt32BE(0)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * 读 OpenClaw 各数据库的 schema 版本，用于判断「doctor 有没有动过数据」。
 *
 * 为什么更新流程必须知道这件事：回滚快照里只有 node_modules / lock / npm，
 * **没有数据库**（见 downloadManager 的 _snapshotOpenClawForUpdate）。doctor 一旦
 * 迁移过 schema，旧二进制的 schema 门槛更低，读不了新库 —— 此时回滚不是恢复，
 * 而是把「新版本起不来」升级成「新旧都起不来」。dev 环境实测过这条死局：
 * state 库被升到 19，回滚到只支持 17 的旧版后，两边都拒绝启动。
 *
 * 比的是**前后是否变化**，所以半迁移（state 升了、agent 没升）也能被检出。
 */
export async function readSchemaVersions(
  getDataDir: () => string
): Promise<SchemaVersionEntry[]> {
  const root = openClawPaths.configDir(getDataDir())
  const abs = [join(root, 'state', 'openclaw.sqlite'), ...agentDbPaths(root)]
  return Promise.all(
    abs.map(async (file) => ({
      file: relative(root, file).split(sep).join('/'),
      version: readUserVersion(file)
    }))
  )
}

/** 枚举各 agent 的数据库（config/.openclaw/agents/<id>/agent/openclaw-agent.sqlite） */
function agentDbPaths(root: string): string[] {
  const agentsDir = join(root, 'agents')
  let ids: string[]
  try {
    ids = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  return ids
    .map((id) => join(agentsDir, id, 'agent', 'openclaw-agent.sqlite'))
    .filter((p) => existsSync(p))
}
