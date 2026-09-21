// 云端技能同步服务
// 上游源：https://gitee.com/bscwdg/umi-claw-skills（国内直连，Gitee API v5 与 raw 地址匿名可读）
// 模式对齐 modelPresets.ts 的 Gitee 拉取：cache-buster 防 CDN 缓存、HTTPS 终态校验、
// 体积上限、失败不动本地。仅整体失败返回 success:false；单个包失败计入 failed 明细。
import { ConfigManager } from './configManager'

export const SKILLS_REPO_API_URL = 'https://gitee.com/api/v5/repos/bscwdg/umi-claw-skills/contents/'
export const SKILLS_REPO_RAW_BASE = 'https://gitee.com/bscwdg/umi-claw-skills/raw/master/'

const FETCH_TIMEOUT_MS = 15_000
const MAX_LIST_BYTES = 1 * 1024 * 1024
const MAX_ZIP_BYTES = 10 * 1024 * 1024
const MAX_VERSIONS_BYTES = 64 * 1024
const MAX_SKILL_FILES = 64
// 只信 API 列表里的文件名，raw 地址一律自行拼接，绝不 fetch 返回体里的 download_url
// （防列表被篡改后指向任意 https 主机——协议校验管不住换主机）。
const ZIP_NAME_RE = /^[\w.-]+\.zip$/
// applyUpdates 的 ids 白名单：与 zip stem / manifest key 同一字符域，拼接 URL 前先校验
const SKILL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface SkillUpdateInfo {
  id: string                  // manifest key = versions.json key = zip 文件名 stem
  remoteVersion: string       // 远端 versions.json 登记的最新版本
  localVersion: string | null // 本地 manifest 记录的已装版本；查不到记 null（UI 显示「未记录」）
}

export interface SkillSyncResult {
  success: boolean              // 整体流程是否跑通（拿到列表）；单包失败不算整体失败
  error?: string                // 仅整体失败时（网络/仓库不可达/列表格式非法）
  total: number                 // 远端 zip 总数
  installed: string[]           // 本次新装的技能 id（SKILL.md name 或 zip 顶层目录名）
  skipped: string[]             // 本地已存在而跳过的（不含可更新的——那些进 updates）
  failed: Array<{ file: string; error: string }>
  updates: SkillUpdateInfo[]    // 本地已装且有更新可选的技能（不下载，等用户勾选）
  hasVersionInfo: boolean       // versions.json 是否成功拉取；false = 降级为现状行为（只装新不检更新）
}

export interface SkillApplyResult {
  success: boolean             // ids 全部处理完（即使部分失败）即 true；仅整体异常才 false
  updated: string[]
  failed: Array<{ id: string; error: string }>
}

export interface SkillSyncOptions {
  externalSignal?: AbortSignal  // 初始化路径传入，用户点取消时立刻中断
  onProgress?: (stepText: string, p01: number) => void  // p01 ∈ [0,1]，UI 百分比映射留给调用方
}

export class SkillSyncService {
  private inFlight: Promise<SkillSyncResult> | null = null
  private applyInFlight: Promise<SkillApplyResult> | null = null
  /** 最近一轮同步检测出的可更新列表；applyUpdates 成功一项删一项，供 UI 跳页回来恢复面板 */
  private lastPendingUpdates: SkillUpdateInfo[] = []

  constructor(private configManager: ConfigManager) {}

  /** 单飞守卫：并发调用合并为同一轮同步（按钮 disabled 只是 UI 层保险） */
  syncFromRemote(options: SkillSyncOptions = {}): Promise<SkillSyncResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this._doSync(options).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  /** 勾选更新与拉取分别守卫，避免互相阻塞（applyUpdates 内部不调 sync） */
  applyUpdates(ids: string[], options: SkillSyncOptions = {}): Promise<SkillApplyResult> {
    if (this.applyInFlight) return this.applyInFlight
    this.applyInFlight = this._doApplyUpdates(ids, options).finally(() => { this.applyInFlight = null })
    return this.applyInFlight
  }

  getPendingUpdates(): SkillUpdateInfo[] {
    return this.lastPendingUpdates
  }

  private async _doSync(options: SkillSyncOptions): Promise<SkillSyncResult> {
    const listResult = await this._fetchList(options.externalSignal)
    if (!listResult.ok) {
      return { success: false, error: listResult.error, total: 0, installed: [], skipped: [], failed: [], updates: [], hasVersionInfo: false }
    }

    // 版本清单拉取失败不致命：降级为「只装新、不检更新」的现状行为
    const versionsResult = await this._fetchVersions(options.externalSignal)
    const versionsOk = versionsResult.ok
    if (!versionsOk) {
      console.warn('[SkillSync] versions.json 拉取失败，本次跳过更新检测:', versionsResult.error)
    }
    const versions = versionsOk ? versionsResult.versions : {}
    const manifest = this.configManager.getSkillManifest()

    const files = listResult.files
    const result: SkillSyncResult = {
      success: true,
      total: files.length,
      installed: [],
      skipped: [],
      failed: [],
      updates: [],
      hasVersionInfo: versionsOk
    }

    for (let i = 0; i < files.length; i++) {
      const fileName = files[i]
      const stem = fileName.replace(/\.zip$/, '')
      options.onProgress?.(`正在检查云端技能 (${i + 1}/${files.length})：${stem}`, i / Math.max(files.length, 1))

      // 预检：本地已存在 → 不下载，转版本比对（versions.json 不可用时维持现状直接跳过）
      // manifest.actualDir 与 stem 不同（规范包顶层目录名 ≠ zip 文件名）时也按 actualDir 判定：
      // 否则漏判后会重复下载并可能装出 <stem> 重复目录，且该技能永远进不了更新比对流程
      const knownActualDir = manifest[stem]?.actualDir
      if (
        this.configManager.hasLocalSkill(stem) ||
        (typeof knownActualDir === 'string' && knownActualDir !== stem && this.configManager.hasLocalSkill(knownActualDir))
      ) {
        const remoteVersion = versions[stem]
        if (!versionsOk || typeof remoteVersion !== 'string') {
          result.skipped.push(stem)
          continue
        }
        const localVersion = manifest[stem]?.version
        if (typeof localVersion === 'string' && localVersion.trim() === remoteVersion.trim()) {
          // 已是最新
          result.skipped.push(stem)
        } else {
          // manifest 无记录（老用户/手动导入）或版本不一致 → 视为可更新，等用户勾选
          result.updates.push({ id: stem, remoteVersion: remoteVersion.trim(), localVersion: localVersion ?? null })
        }
        continue
      }

      const zipResult = await this._fetchZipBuffer(fileName, options.externalSignal)
      if (!zipResult.ok) {
        result.failed.push({ file: fileName, error: zipResult.error })
        continue
      }

      const installResult = this.configManager.installSkillZipData(zipResult.data, stem, { overwrite: false })
      if (installResult.exists) {
        // 权威复查：SKILL.md name 与 zip 文件名不一致时，按实际落盘目录记跳过
        result.skipped.push(installResult.skillId || stem)
      } else if (installResult.success) {
        const skillId = installResult.skillId || stem
        // 版本优先取远端清单登记值；未登记则用包内 SKILL.md 的 version；都没有记 'unknown'
        const version = versions[stem] ?? installResult.version ?? 'unknown'
        this.configManager.recordSkillInstalled(stem, version, skillId)
        result.installed.push(skillId)
      } else {
        result.failed.push({ file: fileName, error: installResult.error || '未知错误' })
      }
    }
    this.lastPendingUpdates = result.updates
    return result
  }

  /**
   * 应用用户勾选的更新：逐个下载对应 zip 并 staging 覆盖替换，成功后刷新 manifest。
   * 传入前主进程已过滤非 string 项；这里再做白名单校验 + 去重。
   */
  private async _doApplyUpdates(ids: string[], options: SkillSyncOptions): Promise<SkillApplyResult> {
    const result: SkillApplyResult = { success: true, updated: [], failed: [] }
    const targets = [...new Set(ids.filter((id): id is string => typeof id === 'string' && SKILL_KEY_RE.test(id)))]
    if (targets.length === 0) {
      return { success: false, updated: [], failed: [{ id: '', error: '没有合法的待更新技能' }] }
    }

    // 重取版本清单拿最新登记版本（拿不到按 'unknown' 处理，仍可更新）
    const versionsResult = await this._fetchVersions(options.externalSignal)
    const versions = versionsResult.ok ? versionsResult.versions : {}
    if (!versionsResult.ok) {
      console.warn('[SkillSync] 更新时 versions.json 拉取失败，版本号将以包内字段为准:', versionsResult.error)
    }
    const manifest = this.configManager.getSkillManifest()

    for (let i = 0; i < targets.length; i++) {
      const id = targets[i]
      options.onProgress?.(`正在更新技能 (${i + 1}/${targets.length})：${id}`, i / Math.max(targets.length, 1))

      const zipResult = await this._fetchZipBuffer(`${id}.zip`, options.externalSignal)
      if (!zipResult.ok) {
        result.failed.push({ id, error: zipResult.error })
        continue
      }

      const updateResult = this.configManager.updateSkillZipData(zipResult.data, id, manifest[id]?.actualDir)
      if (!updateResult.success) {
        result.failed.push({ id, error: updateResult.error || '未知错误' })
        continue
      }

      const version = versions[id] ?? updateResult.version ?? 'unknown'
      this.configManager.recordSkillInstalled(id, version, updateResult.actualDir || id)
      // 回填 id（manifest key），前端按 id 从勾选面板移除；actualDir 已记入 manifest
      result.updated.push(id)
      // 同步 pending 缓存，UI 面板对应项消失
      this.lastPendingUpdates = this.lastPendingUpdates.filter((u) => u.id !== id)
    }
    return result
  }

  /** 拉取仓库根目录文件列表，筛出全部 zip 文件名 */
  private async _fetchList(externalSignal?: AbortSignal): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
    let res: Response
    try {
      // cache-buster：绕开 Gitee 的 CDN 缓存，保证拉到刚推送的内容
      res = await fetch(`${SKILLS_REPO_API_URL}?t=${Date.now()}`, {
        signal: this._makeSignal(externalSignal)
      })
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err // 用户取消，调用方（初始化）需识别
      return { ok: false, error: `网络请求失败：${err instanceof Error ? err.message : err}` }
    }
    if (!res.ok) return { ok: false, error: `远端返回 HTTP ${res.status}` }
    const downgrade = this._httpsDowngradeProblem(res, SKILLS_REPO_API_URL)
    if (downgrade) return { ok: false, error: downgrade }
    const declaredLen = Number(res.headers.get('content-length') || 0)
    if (declaredLen > MAX_LIST_BYTES) return { ok: false, error: '响应体积超出上限，已拒绝' }

    let text: string
    try {
      text = await res.text()
    } catch (err: any) {
      return { ok: false, error: `读取响应失败：${err instanceof Error ? err.message : err}` }
    }
    if (text.length > MAX_LIST_BYTES) return { ok: false, error: '响应体积超出上限，已拒绝' }

    let doc: any
    try {
      doc = JSON.parse(text)
    } catch {
      return { ok: false, error: '返回内容不是合法 JSON' }
    }
    if (!Array.isArray(doc)) return { ok: false, error: '远端列表格式非法' }

    const files = doc
      .filter((item: any) => item && item.type === 'file' && typeof item.name === 'string' && ZIP_NAME_RE.test(item.name))
      .map((item: any) => item.name as string)
      .slice(0, MAX_SKILL_FILES)
    return { ok: true, files }
  }

  /**
   * 拉取远端 versions.json 版本清单（{ 技能名: 版本号 }），作为更新检测的数据源。
   * 404 / 格式非法不算致命错误：返回 ok:false，调用方降级为现状行为（只装新、不检更新）。
   */
  private async _fetchVersions(externalSignal?: AbortSignal): Promise<{ ok: true; versions: Record<string, string> } | { ok: false; error: string }> {
    const url = `${SKILLS_REPO_RAW_BASE}versions.json`
    let res: Response
    try {
      res = await fetch(`${url}?t=${Date.now()}`, { signal: this._makeSignal(externalSignal) })
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err
      return { ok: false, error: `网络请求失败：${err instanceof Error ? err.message : err}` }
    }
    if (res.status === 404) return { ok: false, error: '远端尚未部署 versions.json' }
    if (!res.ok) return { ok: false, error: `远端返回 HTTP ${res.status}` }
    const downgrade = this._httpsDowngradeProblem(res, url)
    if (downgrade) return { ok: false, error: downgrade }
    const declaredLen = Number(res.headers.get('content-length') || 0)
    if (declaredLen > MAX_VERSIONS_BYTES) return { ok: false, error: '版本清单体积超出上限，已拒绝' }

    let text: string
    try {
      text = await res.text()
    } catch (err: any) {
      return { ok: false, error: `读取响应失败：${err instanceof Error ? err.message : err}` }
    }
    if (text.length > MAX_VERSIONS_BYTES) return { ok: false, error: '版本清单体积超出上限，已拒绝' }

    let doc: any
    try {
      doc = JSON.parse(text)
    } catch {
      return { ok: false, error: '版本清单不是合法 JSON' }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: '版本清单格式非法' }

    // 逐条校验，剔除非法条目；空对象视为 ok（远端可能还没登记任何技能）
    const versions: Record<string, string> = {}
    for (const [key, val] of Object.entries(doc)) {
      if (typeof key === 'string' && typeof val === 'string') versions[key] = val
    }
    return { ok: true, versions }
  }

  /** 下载单个技能 zip 到内存缓冲区 */
  private async _fetchZipBuffer(fileName: string, externalSignal?: AbortSignal): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
    const url = `${SKILLS_REPO_RAW_BASE}${fileName}`
    let res: Response
    try {
      res = await fetch(`${url}?t=${Date.now()}`, { signal: this._makeSignal(externalSignal) })
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err
      return { ok: false, error: `下载失败：${err instanceof Error ? err.message : err}` }
    }
    if (!res.ok) return { ok: false, error: `下载失败：远端返回 HTTP ${res.status}` }
    const downgrade = this._httpsDowngradeProblem(res, url)
    if (downgrade) return { ok: false, error: downgrade }
    const declaredLen = Number(res.headers.get('content-length') || 0)
    if (declaredLen > MAX_ZIP_BYTES) return { ok: false, error: '文件体积超出上限，已拒绝' }

    let data: Buffer
    try {
      data = Buffer.from(await res.arrayBuffer())
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err
      return { ok: false, error: `读取文件失败：${err instanceof Error ? err.message : err}` }
    }
    if (data.length > MAX_ZIP_BYTES) return { ok: false, error: '文件体积超出上限，已拒绝' }
    if (!(data[0] === 0x50 && data[1] === 0x4b)) return { ok: false, error: '内容不是有效的 zip 包' }
    return { ok: true, data }
  }

  /** 15s 超时与外部取消信号合并（Electron 30 主进程 = Node 20.11，AbortSignal.any 可用） */
  private _makeSignal(external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    return external ? AbortSignal.any([timeout, external]) : timeout
  }

  /** 防 https → http 降级：Gitee raw 正常 302 到 https CDN，终态必为 https（照抄 modelPresets） */
  private _httpsDowngradeProblem(res: Response, requestUrl: string): string | null {
    try {
      const finalUrl = new URL(res.url || requestUrl)
      if (finalUrl.protocol !== 'https:') return '重定向到非 HTTPS 地址，已拒绝'
    } catch {
      return '最终响应地址非法，已拒绝'
    }
    return null
  }
}
