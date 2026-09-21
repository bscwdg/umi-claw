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
const MAX_SKILL_FILES = 64
// 只信 API 列表里的文件名，raw 地址一律自行拼接，绝不 fetch 返回体里的 download_url
// （防列表被篡改后指向任意 https 主机——协议校验管不住换主机）。
const ZIP_NAME_RE = /^[\w.-]+\.zip$/

export interface SkillSyncResult {
  success: boolean              // 整体流程是否跑通（拿到列表）；单包失败不算整体失败
  error?: string                // 仅整体失败时（网络/仓库不可达/列表格式非法）
  total: number                 // 远端 zip 总数
  installed: string[]           // 本次新装的技能 id（SKILL.md name 或 zip 顶层目录名）
  skipped: string[]             // 本地已存在而跳过的
  failed: Array<{ file: string; error: string }>
}

export interface SkillSyncOptions {
  externalSignal?: AbortSignal  // 初始化路径传入，用户点取消时立刻中断
  onProgress?: (stepText: string, p01: number) => void  // p01 ∈ [0,1]，UI 百分比映射留给调用方
}

export class SkillSyncService {
  private inFlight: Promise<SkillSyncResult> | null = null

  constructor(private configManager: ConfigManager) {}

  /** 单飞守卫：并发调用合并为同一轮同步（按钮 disabled 只是 UI 层保险） */
  syncFromRemote(options: SkillSyncOptions = {}): Promise<SkillSyncResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this._doSync(options).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async _doSync(options: SkillSyncOptions): Promise<SkillSyncResult> {
    const listResult = await this._fetchList(options.externalSignal)
    if (!listResult.ok) {
      return { success: false, error: listResult.error, total: 0, installed: [], skipped: [], failed: [] }
    }

    const files = listResult.files
    const result: SkillSyncResult = {
      success: true,
      total: files.length,
      installed: [],
      skipped: [],
      failed: []
    }

    for (let i = 0; i < files.length; i++) {
      const fileName = files[i]
      const stem = fileName.replace(/\.zip$/, '')
      options.onProgress?.(`正在安装云端技能 (${i + 1}/${files.length})：${stem}`, i / Math.max(files.length, 1))

      // 预检：本地已存在直接跳过，省一次下载
      if (this.configManager.hasLocalSkill(stem)) {
        result.skipped.push(stem)
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
        result.installed.push(installResult.skillId || stem)
      } else {
        result.failed.push({ file: fileName, error: installResult.error || '未知错误' })
      }
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
