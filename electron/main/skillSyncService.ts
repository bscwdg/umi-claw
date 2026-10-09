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
const MAX_README_BYTES = 256 * 1024
// contents API 信封整体上限：base64 ≈ 原文 4/3 再加 JSON 包装，给 2 倍余量
const MAX_README_API_BYTES = MAX_README_BYTES * 2
// 解码前的 base64 文本上限（≈ 解码字节 × 4/3 + padding），卡住后不再按全量分配内存
const MAX_README_BASE64_BYTES = Math.ceil((MAX_README_BYTES * 4) / 3) + 4
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

/** 探测阶段发现的本地未安装技能（弹窗勾选项） */
export interface SkillAvailableInfo {
  id: string                  // zip stem = manifest key（安装锚点）
  version: string | null      // versions.json 登记版本；清单不可用/未登记记 null
  usage: string               // 仓库 README「Skill 总览」表格里的用途说明；取不到记 ''
}

/** 只读探测结果：拿远端列表 + 版本清单做分类，不下载任何 zip */
export interface SkillProbeResult {
  success: boolean
  error?: string              // 仅整体失败时（网络/仓库不可达/列表格式非法）
  total: number               // 远端 zip 总数
  available: SkillAvailableInfo[] // 本地未安装，弹窗勾选后才下载
  skipped: string[]           // 已安装且最新
  updates: SkillUpdateInfo[]  // 已安装且有更新（进更新勾选面板）
  hasVersionInfo: boolean
}

/** 按勾选导入新技能的结果 */
export interface SkillInstallResult {
  success: boolean            // ids 全部处理完（即使部分失败）即 true；仅整体异常才 false
  installed: string[]
  skipped: string[]           // 目标目录已存在（含平铺包 name ≠ stem 的正常情形），不算失败
  failed: Array<{ id: string; error: string }>
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
  private probeInFlight: Promise<SkillProbeResult> | null = null
  private installInFlight: Promise<SkillInstallResult> | null = null
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

  /** 只读探测（技能页「拉取云端技能」）：只拉列表 + 版本清单做分类，不下载；随后弹窗勾选 */
  probeFromRemote(options: SkillSyncOptions = {}): Promise<SkillProbeResult> {
    if (this.probeInFlight) return this.probeInFlight
    this.probeInFlight = this._doProbe(options).finally(() => { this.probeInFlight = null })
    return this.probeInFlight
  }

  /**
   * 按弹窗勾选导入新技能（zip 下载在用户确认后才发生）。
   * 注意单飞是「合并」而非「拒绝」：在途时第二批即使带不同 ids 也会拿到第一批的
   * 结果，不能当作同批请求的幂等依赖；当前 UI 不可达（初始化时进不了技能页、
   * 弹窗遮罩挡住重复点击），改动调用方时需先确认这层。
   */
  installSkills(ids: string[], options: SkillSyncOptions = {}): Promise<SkillInstallResult> {
    if (this.installInFlight) return this.installInFlight
    this.installInFlight = this._doInstallSkills(ids, options).finally(() => { this.installInFlight = null })
    return this.installInFlight
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

  /** 技能被移除后，从在途的可更新缓存中剔除，避免跳页回来它又出现在更新面板 */
  dropPendingUpdate(id: string): void {
    this.lastPendingUpdates = this.lastPendingUpdates.filter((u) => u.id !== id)
  }

  /**
   * 一键初始化路径（downloadManager._installBuiltinSkills）：探测后自动安装全部新技能。
   * installed/skipped/failed 字段口径与旧版保持一致（failed.file 仍是完整 zip 文件名）。
   */
  private async _doSync(options: SkillSyncOptions): Promise<SkillSyncResult> {
    const probe = await this._doProbe(options)
    if (!probe.success) {
      return { success: false, error: probe.error, total: 0, installed: [], skipped: [], failed: [], updates: [], hasVersionInfo: false }
    }
    let installed: string[] = []
    let skipped: string[] = [...probe.skipped]
    let failed: Array<{ file: string; error: string }> = []
    if (probe.available.length > 0) {
      // 走公开方法：与 UI 路径共用单飞守卫，初始化期间的并发也受保护
      const install = await this.installSkills(
        probe.available.map((a) => a.id),
        options
      )
      installed = install.installed
      skipped.push(...install.skipped)
      failed = install.failed.map((f) => ({ file: `${f.id}.zip`, error: f.error }))
    }
    return {
      success: true,
      total: probe.total,
      installed,
      skipped,
      failed,
      updates: probe.updates,
      hasVersionInfo: probe.hasVersionInfo
    }
  }

  /**
   * 只读探测：拉远端文件列表 + versions.json，对每个 zip 做本地存在性分类，全程不下载。
   * 分类结果 updates 同步进 lastPendingUpdates，供页面跳页恢复更新面板。
   */
  private async _doProbe(options: SkillSyncOptions): Promise<SkillProbeResult> {
    const listResult = await this._fetchList(options.externalSignal)
    if (!listResult.ok) {
      return { success: false, error: listResult.error, total: 0, available: [], skipped: [], updates: [], hasVersionInfo: false }
    }

    // 版本清单拉取失败不致命：降级为「只列新技能、不检更新」
    const versionsResult = await this._fetchVersions(options.externalSignal)
    const versionsOk = versionsResult.ok
    if (!versionsOk) {
      console.warn('[SkillSync] versions.json 拉取失败，本次跳过更新检测:', versionsResult.error)
    }
    const versions = versionsOk ? versionsResult.versions : {}
    const manifest = this.configManager.getSkillManifest()
    // README 用途表（失败静默为 null，弹窗只是不显示 ?，不影响主流程）
    const usageMap = await this._fetchReadmeUsages(options.externalSignal)

    const files = listResult.files
    const result: SkillProbeResult = {
      success: true,
      total: files.length,
      available: [],
      skipped: [],
      updates: [],
      hasVersionInfo: versionsOk
    }

    for (let i = 0; i < files.length; i++) {
      const fileName = files[i]
      const stem = fileName.replace(/\.zip$/, '')
      // 白名单口径只留一处：列表过滤（ZIP_NAME_RE）允许 _/./- 开头，这类 stem 不在
      // URL 安全字符域内，探测阶段直接排除，避免进弹窗后被安装路径静默丢项
      if (!SKILL_KEY_RE.test(stem)) continue
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

      // 本地未安装：只登记不下载，等弹窗勾选；版本未登记记 null（弹窗显示「未登记版本」）
      const remoteVersion = versions[stem]
      result.available.push({
        id: stem,
        version: versionsOk && typeof remoteVersion === 'string' ? remoteVersion.trim() : null,
        usage: usageMap?.[stem] ?? ''
      })
    }
    this.lastPendingUpdates = result.updates
    return result
  }

  /**
   * 按用户勾选下载并安装新技能（overwrite:false），成功后写 manifest 台账。
   * 传入前主进程已过滤非 string 项；这里再做白名单校验 + 去重。
   */
  private async _doInstallSkills(ids: string[], options: SkillSyncOptions): Promise<SkillInstallResult> {
    const result: SkillInstallResult = { success: true, installed: [], skipped: [], failed: [] }
    const targets = [...new Set(ids.filter((id): id is string => typeof id === 'string' && SKILL_KEY_RE.test(id)))]
    if (targets.length === 0) {
      // 不产生空 id 的 failed 项；前端按 success:false 提示
      return { success: false, installed: [], skipped: [], failed: [] }
    }

    // 重取版本清单拿最新登记版本（弹窗可能开了一段时间）；拿不到则按包内字段为准
    const versionsResult = await this._fetchVersions(options.externalSignal)
    const versions = versionsResult.ok ? versionsResult.versions : {}
    if (!versionsResult.ok) {
      console.warn('[SkillSync] 导入时 versions.json 拉取失败，版本号将以包内字段为准:', versionsResult.error)
    }

    for (let i = 0; i < targets.length; i++) {
      const id = targets[i]
      options.onProgress?.(`正在导入技能 (${i + 1}/${targets.length})：${id}`, i / Math.max(targets.length, 1))

      const zipResult = await this._fetchZipBuffer(`${id}.zip`, options.externalSignal)
      if (!zipResult.ok) {
        result.failed.push({ id, error: zipResult.error })
        continue
      }

      const installResult = this.configManager.installSkillZipData(zipResult.data, id, { overwrite: false })
      if (installResult.exists) {
        // 不只是竞态：平铺包按 SKILL.md 的 name 落盘，该目录已存在而 manifest 没有
        // stem→actualDir 映射时必到这里。归为 skipped，并补记 manifest：下一轮探测
        // 命中 actualDir 兜底分支，不再每次拉取都冒出来。
        // 副作用：这是全项目第一次把「不是自己创建的目录」登记为受管技能。之后远端
        // 升版本，它会出现在更新面板，用户确认后 updateSkillZipData 会按 manifest 的
        // actualDir 做 staging 覆盖（即替换该目录）——这是消除反复冒出的必要代价。
        const existingDir = installResult.skillId || id
        this.configManager.recordSkillInstalled(
          id,
          versions[id] ?? installResult.version ?? 'unknown',
          existingDir
        )
        result.skipped.push(existingDir)
        continue
      }
      if (!installResult.success) {
        result.failed.push({ id, error: installResult.error || '未知错误' })
        continue
      }

      const skillId = installResult.skillId || id
      const version = versions[id] ?? installResult.version ?? 'unknown'
      this.configManager.recordSkillInstalled(id, version, skillId)
      result.installed.push(skillId)
    }
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
      return { success: false, updated: [], failed: [] }
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
   * 拉仓库 README 并解析「Skill 总览」表格，得到 id → 用途说明。
   * 走 API contents 拿 base64（raw 地址在部分网络环境会被拦截），失败一律静默降级返回 null，
   * 不影响探测主流程；拿不到用途时弹窗不显示「?」。
   */
  private async _fetchReadmeUsages(
    externalSignal?: AbortSignal
  ): Promise<Record<string, string> | null> {
    try {
      const url = `${SKILLS_REPO_API_URL}README.md`
      const res = await fetch(`${url}?t=${Date.now()}`, {
        signal: this._makeSignal(externalSignal)
      })
      if (!res.ok) return null
      const downgrade = this._httpsDowngradeProblem(res, url)
      if (downgrade) return null
      // 读 body 前先卡信封体积（与本文件其他 fetch 同口径）
      const declaredLen = Number(res.headers.get('content-length') || 0)
      if (declaredLen > MAX_README_API_BYTES) return null
      const doc = await res.json()
      if (!doc || typeof doc.content !== 'string') return null
      // 解码前卡 base64 长度：超限时 Buffer.from 已无需按全量分配内存
      if (doc.content.length > MAX_README_BASE64_BYTES) return null
      let markdown: string
      try {
        markdown = Buffer.from(doc.content, 'base64').toString('utf8')
      } catch {
        return null
      }
      if (markdown.length > MAX_README_BYTES) return null
      return this._parseReadmeUsageTable(markdown)
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err
      console.warn('[SkillSync] README 拉取失败，用途说明本次不可用:', err?.message || err)
      return null
    }
  }

  /**
   * 解析 README 的「Skill 总览」markdown 表格：按表头定位「包名」列与「用途」列
   * （不硬编码列顺序），包名取链接锚点，用途列剥掉反引号/加粗等 markdown 标记。
   */
  private _parseReadmeUsageTable(markdown: string): Record<string, string> {
    const usages: Record<string, string> = {}
    const lines = markdown.split(/\r?\n/)
    let inOverview = false
    let sawHeader = false
    let nameCol = 0
    let usageCol = 1

    for (const line of lines) {
      if (/^#{1,6}\s/.test(line)) {
        // 进入新章节：只认总览章节里的表格，避免后面版本管理等表格混入
        inOverview = /总览/.test(line)
        sawHeader = false
        continue
      }
      if (!inOverview) continue
      const trimmed = line.trim()
      if (!trimmed.startsWith('|')) continue
      const cols = trimmed.split('|').slice(1, -1).map((c) => c.trim())
      if (cols.length < 2) continue

      if (!sawHeader) {
        sawHeader = true
        const foundName = cols.findIndex((c) => /包名|名称|skill/i.test(c))
        const foundUsage = cols.findIndex((c) => /用途|说明|描述/.test(c))
        nameCol = foundName >= 0 ? foundName : 0
        usageCol = foundUsage >= 0 ? foundUsage : 1
        continue
      }
      // 跳过分隔行 |------|
      if (cols.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')))) continue

      const nameCell = cols[nameCol] ?? ''
      const linkMatch = nameCell.match(/\[[^\]]*\]\(([^)]*)\)/)
      let id: string
      if (linkMatch && linkMatch[1].startsWith('#')) {
        // [byted-web-search](#byted-web-search)：取锚点
        id = linkMatch[1].slice(1)
      } else {
        // 普通链接 / 纯文本（可能写成 xxx.zip）：取显示文本并去掉 .zip 后缀
        id = this._stripMarkdown(nameCell).replace(/\.zip$/i, '')
      }
      const usage = this._stripMarkdown(cols[usageCol] ?? '')
      if (id && usage && SKILL_KEY_RE.test(id)) usages[id] = usage
    }
    return usages
  }

  /** 剥掉行内 markdown：反引号、加粗、链接保留显示文本 */
  private _stripMarkdown(text: string): string {
    return text
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim()
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
