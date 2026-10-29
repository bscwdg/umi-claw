import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, extname, join, resolve, sep } from 'path'
import { VOICE_ERROR_CODES, VoiceError } from './errors'
import type { VoiceStorage } from './storage'
import type {
  VoiceReconcileItem,
  VoiceCloneActivateInput,
  VoiceCloneRecord,
  VoiceCloneSample,
  VoiceCloneTrainInput,
  VoiceCloneValidation,
  VoiceSpeakResult
} from './types'
import type { VoiceSecretStore } from '../secretStore'
import { VOICE_ENDPOINTS } from './settings'
import { normalizeCloneLanguage } from './cloneLanguage'
import type { VoiceManager } from './manager'
import { VolcengineCloneProvider, type CloneProviderStatus } from '../providers/volcengineClone'

const CLONES_KEY = 'voice:v1:clones'
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024
const SAMPLE_TOKEN_TTL_MS = 30 * 60 * 1000
const CLONE_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000
const ALLOWED_FORMATS = new Set(['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'])
/** 后台轮询：基础间隔取 pollIntervalMs（默认 2s），指数退避封顶 10s，最长 10 分钟。 */
const POLL_MAX_DELAY_MS = 10_000
const POLL_MAX_MS = 10 * 60 * 1000

type FetchLike = typeof fetch

interface SampleRegistration {
  path: string
  sample: VoiceCloneSample
  expiresAt: number
}

export interface VoiceCloneManagerOptions {
  storage: VoiceStorage
  secrets: VoiceSecretStore
  voicesDir: string
  voiceManager: VoiceManager
  fetchImpl?: FetchLike
  now?: () => number
  logger?: (message: string) => void
  pollIntervalMs?: number
}

function formatOf(fileName: string): string {
  return extname(fileName).replace(/^\./, '').toLowerCase()
}

function mimeForFormat(format: string): string {
  if (format === 'wav') return 'audio/wav'
  if (format === 'ogg') return 'audio/ogg'
  if (format === 'm4a') return 'audio/mp4'
  if (format === 'aac') return 'audio/aac'
  if (format === 'pcm') return 'audio/L16'
  return 'audio/mpeg'
}

function sniffExtension(data: Buffer, contentType: string, fallback: string): string {
  const ct = contentType.toLowerCase()
  if (ct.includes('wav')) return 'wav'
  if (ct.includes('ogg')) return 'ogg'
  if (ct.includes('mp4') || ct.includes('m4a')) return 'm4a'
  if (ct.includes('aac')) return 'aac'
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF') return 'wav'
  if (data.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg'
  if (data.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a'
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return 'aac'
  if (data.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3'
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'mp3'
  return fallback
}

function statusName(status: number): VoiceCloneRecord['status'] {
  if (status === 1) return 'training'
  if (status === 2 || status === 4) return 'success'
  if (status === 3) return 'failed'
  return 'not_found'
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

function validateGeneratedSpeakerId(value: string): boolean {
  return (
    value.length >= 8 &&
    value.length <= 256 &&
    /^[A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9]$/.test(value) &&
    !/^(S_|ICL_|MIX_|DiT_|BV)/i.test(value)
  )
}

export class VoiceCloneManager {
  private readonly storage: VoiceStorage
  private readonly secrets: VoiceSecretStore
  private readonly voicesDir: string
  private readonly voiceManager: VoiceManager
  private readonly provider: VolcengineCloneProvider
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly logger: (message: string) => void
  private readonly pollIntervalMs: number
  private recordsCache: VoiceCloneRecord[] | null = null
  private readonly samples = new Map<string, SampleRegistration>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly polls = new Map<string, { attempts: number; startedAt: number }>()
  private readonly activationInflight = new Map<string, Promise<VoiceSpeakResult>>()

  constructor(options: VoiceCloneManagerOptions) {
    this.storage = options.storage
    this.secrets = options.secrets
    this.voicesDir = resolve(options.voicesDir)
    this.voiceManager = options.voiceManager
    this.fetchImpl = options.fetchImpl ?? fetch
    this.provider = new VolcengineCloneProvider(this.fetchImpl)
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger ?? ((message) => console.log(message))
    this.pollIntervalMs = options.pollIntervalMs ?? 2000
    this.voiceManager.setCloneGate(async (speaker) => {
      const record = await this.findRecord(speaker)
      if (!record) return { ok: false, message: '未知的克隆音色' }
      if (record.activated) return { ok: true }
      if (record.expiresAt && record.expiresAt < this.now()) {
        return { ok: false, message: '该克隆音色已过 7 天保留期，请重新训练' }
      }
      return {
        ok: false,
        message: '该克隆音色首次正式合成将收取槽位费，请先在克隆向导中确认'
      }
    })
  }

  /**
   * 取当前生效的克隆相关端点。
   * 走设置而非常量，这样「接口与模型」里改的地址真的会作用到训练/查询。
   */
  private async cloneEndpoints(): Promise<{
    train: string
    status: string
  }> {
    const settings = await this.voiceManager.getSettings()
    return {
      train: settings.cloneTrainEndpoint || VOICE_ENDPOINTS.cloneTrain,
      status: settings.cloneStatusEndpoint || VOICE_ENDPOINTS.cloneStatus
    }
  }

  private async loadRecords(): Promise<VoiceCloneRecord[]> {
    if (this.recordsCache) return this.recordsCache
    const raw = await this.storage.get(CLONES_KEY)
    if (!raw) {
      this.recordsCache = []
      return this.recordsCache
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      this.recordsCache = Array.isArray(parsed) ? (parsed as VoiceCloneRecord[]) : []
    } catch {
      this.recordsCache = []
    }
    return this.recordsCache
  }

  private async saveRecords(records: VoiceCloneRecord[]): Promise<void> {
    this.recordsCache = records
    await this.storage.set(CLONES_KEY, JSON.stringify(records))
  }

  private async findRecord(speakerId: string): Promise<VoiceCloneRecord | null> {
    const records = await this.loadRecords()
    return records.find((record) => record.speakerId === speakerId) ?? null
  }

  private async updateRecord(
    speakerId: string,
    update: Partial<VoiceCloneRecord>
  ): Promise<VoiceCloneRecord> {
    const records = await this.loadRecords()
    const index = records.findIndex((record) => record.speakerId === speakerId)
    if (index < 0) {
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '克隆音色不存在')
    }
    const next: VoiceCloneRecord = {
      ...records[index],
      ...update,
      updatedAt: this.now()
    }
    const copy = records.slice()
    copy[index] = next
    await this.saveRecords(copy)
    return next
  }

  async registerSample(filePath: string): Promise<VoiceCloneSample> {
    const path = resolve(filePath)
    const stat = await fs.stat(path).catch(() => null)
    if (!stat || !stat.isFile()) {
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '未找到样本文件')
    }
    const fileName = basename(path)
    const format = formatOf(fileName)
    if (!ALLOWED_FORMATS.has(format)) {
      throw new VoiceError(
        VOICE_ERROR_CODES.INVALID_INPUT,
        '样本格式仅支持 wav/mp3/ogg/m4a/aac/pcm'
      )
    }
    if (stat.size <= 0 || stat.size > MAX_SAMPLE_BYTES) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '样本大小必须在 0–10MB 之间')
    }
    const token = randomUUID()
    const sample: VoiceCloneSample = {
      token,
      fileName,
      sizeBytes: stat.size,
      format
    }
    this.samples.set(token, {
      path,
      sample,
      expiresAt: this.now() + SAMPLE_TOKEN_TTL_MS
    })
    return sample
  }

  private async getSample(token: string): Promise<SampleRegistration> {
    const entry = this.samples.get(token)
    if (!entry || entry.expiresAt < this.now()) {
      this.samples.delete(token)
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '样本选择已过期，请重新选择文件')
    }
    return entry
  }

  async validate(token: string): Promise<VoiceCloneValidation> {
    const entry = await this.getSample(token)
    const stat = await fs.stat(entry.path).catch(() => null)
    if (!stat || !stat.isFile()) {
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '样本文件已不存在')
    }
    const warnings: string[] = []
    if (stat.size > MAX_SAMPLE_BYTES) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '样本超过 10MB')
    }
    if (stat.size < 5 * 1024) warnings.push('样本文件很小，训练成功率可能较低')
    if (entry.sample.format === 'pcm') warnings.push('PCM 仅支持 24kHz 单声道，请确认格式')
    if (stat.size > 8 * 1024 * 1024) warnings.push('样本接近 10MB 上限')
    const head = Buffer.alloc(16)
    const fh = await fs.open(entry.path, 'r')
    try {
      await fh.read(head, 0, head.length, 0)
    } finally {
      await fh.close()
    }
    const ext = entry.sample.format
    const validMagic =
      (ext === 'wav' && head.subarray(0, 4).toString('ascii') === 'RIFF') ||
      (ext === 'ogg' && head.subarray(0, 4).toString('ascii') === 'OggS') ||
      (ext === 'm4a' && head.subarray(4, 8).toString('ascii') === 'ftyp') ||
      (ext === 'mp3' &&
        (head.subarray(0, 3).toString('ascii') === 'ID3' ||
          (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))) ||
      (ext === 'aac' && head[0] === 0xff && (head[1] & 0xf6) === 0xf0) ||
      ext === 'pcm'
    if (!validMagic) warnings.push('文件头与扩展名不一致，建议转换后重试')
    return {
      token,
      fileName: entry.sample.fileName,
      sizeBytes: stat.size,
      format: entry.sample.format,
      ok: true,
      warnings
    }
  }

  async list(): Promise<VoiceCloneRecord[]> {
    const records = await this.loadRecords()
    return records
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => JSON.parse(JSON.stringify(record)) as VoiceCloneRecord)
  }

  async train(input: VoiceCloneTrainInput): Promise<VoiceCloneRecord> {
    if (!input?.consent) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '必须确认样本为本人或已获授权')
    }
    const displayName = String(input.displayName ?? '').trim().slice(0, 40)
    if (displayName.length < 1) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '请填写音色名称')
    }
    const key = await this.secrets.get('clone')
    if (!key) {
      throw new VoiceError(VOICE_ERROR_CODES.KEY_REQUIRED, '请先保存语音服务 Key')
    }
    const entry = await this.getSample(input.token)
    const audio = await fs.readFile(entry.path)
    const speakerId = `umi_voice_${Date.now().toString(36)}_${randomUUID()
      .replace(/-/g, '')
      .slice(0, 10)}`
    if (!validateGeneratedSpeakerId(speakerId)) {
      throw new VoiceError(VOICE_ERROR_CODES.CLONE_FAILED, '生成的音色 ID 不符合供应商规则')
    }
    const at = this.now()
    const record: VoiceCloneRecord = {
      speakerId,
      displayName,
      status: 'training',
      remoteStatus: 1,
      createdAt: at,
      updatedAt: at,
      consentAt: at,
      sampleHash: createHash('sha256').update(audio).digest('hex'),
      sampleFileName: entry.sample.fileName,
      language: normalizeCloneLanguage(input.language),
      modelTypes: [],
      demos: [],
      activated: false,
      activatedAt: null,
      expiresAt: at + CLONE_EXPIRE_MS,
      availableTrainingTimes: null,
      lastError: null
    }
    const records = await this.loadRecords()
    await this.saveRecords([record, ...records])

    try {
      const eps = await this.cloneEndpoints()
      const status = await this.provider.train({
        endpoint: eps.train,
        apiKey: key,
        customSpeakerId: speakerId,
        audioBase64: audio.toString('base64'),
        format: entry.sample.format,
        text: typeof input.text === 'string' ? input.text.trim().slice(0, 2000) : undefined,
        language: record.language,
        demoText: typeof input.demoText === 'string' ? input.demoText.trim() : undefined,
        enableAudioDenoise: input.enableAudioDenoise === true,
        disableVolumeNormalization: input.disableVolumeNormalization === true
      })
      this.samples.delete(input.token)
      const next = await this.applyRemoteStatus(speakerId, status)
      this.afterRemoteStatus(speakerId, next)
      return next
    } catch (error) {
      // 请求超时也可能已被供应商受理；先查询一次，避免用户重复提交。
      try {
        const eps = await this.cloneEndpoints()
        const status = await this.provider.getStatus(
          eps.status,
          key,
          speakerId
        )
        if (status.status !== 0) {
          const next = await this.applyRemoteStatus(speakerId, status)
          this.afterRemoteStatus(speakerId, next)
          return next
        }
      } catch {
        // 查询失败则落到下面的失败记录
      }
      await this.updateRecord(speakerId, {
        status: 'failed',
        remoteStatus: null,
        lastError: safeError(error)
      }).catch(() => undefined)
      throw error
    }
  }

  private async applyRemoteStatus(
    speakerId: string,
    status: CloneProviderStatus
  ): Promise<VoiceCloneRecord> {
    const current = await this.findRecord(speakerId)
    if (!current) throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '克隆音色记录不存在')
    if (status.logId) {
      // 官方建议保存 X-Tt-Logid 便于报障定位；脱敏日志里只留 logid 与音色 ID。
      this.logger(`[voice] clone logid=${status.logId} speaker=${speakerId}`)
    }
    const mapped = statusName(status.status)
    let next = await this.updateRecord(speakerId, {
      status: current.activated && (mapped === 'success' || mapped === 'active') ? 'active' : mapped,
      remoteStatus: status.status,
      modelTypes: status.modelTypes,
      availableTrainingTimes: status.availableTrainingTimes,
      lastError: mapped === 'failed' ? status.message || '训练失败' : null,
      expiresAt: current.activated ? null : current.expiresAt ?? current.createdAt + CLONE_EXPIRE_MS
    })
    if (mapped === 'success' || mapped === 'active') {
      next = await this.downloadDemos(next, status)
    }
    return next
  }

  /** 训练仍是异步的：拿到 training 就交给主进程后台跟进，页面关掉也不会停。 */
  private afterRemoteStatus(speakerId: string, record: VoiceCloneRecord): void {
    if (record.status === 'training') this.startPolling(speakerId)
    else this.stopPolling(speakerId)
  }

  private async downloadDemos(
    record: VoiceCloneRecord,
    status: CloneProviderStatus
  ): Promise<VoiceCloneRecord> {
    // 不再按 model_type 白名单过滤：resource 可升级（1.0 返回 1/2/3，2.0 返回 4/5），
    // 写死 4/5 会让切到旧资源的用户一个试听都拿不到。凡是服务端给了 demo_audio 就落盘。
    const wanted = status.demos.filter((demo) => demo.modelType > 0 && !!demo.demoAudio)
    if (!wanted.length) return record
    const dir = this.voiceDir(record.speakerId)
    await fs.mkdir(dir, { recursive: true })
    const demos = record.demos.slice()
    for (const demo of wanted) {
      if (demos.some((item) => item.modelType === demo.modelType)) continue
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 20_000)
        try {
          const response = await this.fetchImpl(demo.demoAudio, { signal: controller.signal })
          if (!response || !response.ok) continue
          const data = Buffer.from(await response.arrayBuffer())
          if (!data.length) continue
          const format = sniffExtension(
            data,
            response.headers.get('content-type') ?? '',
            'mp3'
          )
          const fileName = `demo-${demo.modelType}.${format}`
          const target = join(dir, fileName)
          const tmp = `${target}.${process.pid}-${Date.now()}.tmp`
          await fs.writeFile(tmp, data)
          await fs.rename(tmp, target)
          demos.push({
            modelType: demo.modelType,
            fileName,
            mime: mimeForFormat(format),
            downloadedAt: this.now()
          })
        } finally {
          clearTimeout(timer)
        }
      } catch (error) {
        this.logger(`[voice] 下载克隆试听失败 ${record.speakerId}/${demo.modelType}: ${safeError(error)}`)
      }
    }
    return this.updateRecord(record.speakerId, { demos })
  }

  private schedulePoll(speakerId: string, delay: number, startedAt: number): void {
    if (this.timers.has(speakerId)) return
    if (this.now() - startedAt > POLL_MAX_MS) {
      this.polls.delete(speakerId)
      this.logger(`[voice] 克隆轮询超过 10 分钟仍未完成，停止后台轮询 ${speakerId}（可手动刷新）`)
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(speakerId)
      void this.pollOnce(speakerId).catch((error) => {
        this.logger(`[voice] 克隆轮询失败 ${speakerId}: ${safeError(error)}`)
      })
    }, delay)
    const handle = timer as unknown as { unref?: () => void }
    handle.unref?.()
    this.timers.set(speakerId, timer)
  }

  /**
   * 启动后台轮询。训练是异步的，页面关闭后主进程必须继续跟进，
   * 否则训练结果要等用户下次手动刷新才知道。
   */
  private startPolling(speakerId: string): void {
    if (this.polls.has(speakerId)) return
    const startedAt = this.now()
    this.polls.set(speakerId, { attempts: 0, startedAt })
    this.schedulePoll(speakerId, this.pollIntervalMs, startedAt)
  }

  private stopPolling(speakerId: string): void {
    const timer = this.timers.get(speakerId)
    if (timer) clearTimeout(timer)
    this.timers.delete(speakerId)
    this.polls.delete(speakerId)
  }

  private async pollOnce(speakerId: string): Promise<void> {
    const state = this.polls.get(speakerId) ?? {
      attempts: 0,
      startedAt: this.now()
    }
    state.attempts += 1
    this.polls.set(speakerId, state)
    try {
      const record = await this.refreshStatus(speakerId)
      if (record.status !== 'training') {
        this.stopPolling(speakerId)
        return
      }
    } catch (error) {
      // 鉴权/Key/记录缺失是确定性失败，继续轮询只会刷日志。
      const code = error instanceof VoiceError ? error.code : ''
      if (
        code === VOICE_ERROR_CODES.KEY_REQUIRED ||
        code === VOICE_ERROR_CODES.AUTH_ERROR ||
        code === VOICE_ERROR_CODES.NOT_FOUND
      ) {
        this.stopPolling(speakerId)
        this.logger(`[voice] 克隆轮询终止 ${speakerId}: ${safeError(error)}`)
        return
      }
      // 网络抖动按退避继续重试，直到 10 分钟上限。
      this.logger(`[voice] 克隆轮询失败 ${speakerId}: ${safeError(error)}`)
    }
    const cap = Math.max(this.pollIntervalMs, POLL_MAX_DELAY_MS)
    const next = Math.min(cap, Math.round(this.pollIntervalMs * 1.5 ** state.attempts))
    this.schedulePoll(speakerId, next, state.startedAt)
  }

  /**
   * 启动时恢复未结束的训练轮询：应用重启或页面关闭都不该让任务停在「训练中」。
   * 返回恢复的任务数，便于启动日志核对。
   */
  async resumeTrainingPolls(): Promise<number> {
    const records = await this.loadRecords()
    let resumed = 0
    for (const record of records) {
      if (record.status !== 'training') continue
      this.startPolling(record.speakerId)
      resumed += 1
    }
    if (resumed) this.logger(`[voice] 已恢复 ${resumed} 个克隆训练轮询`)
    return resumed
  }

  async refresh(speakerId: string): Promise<VoiceCloneRecord> {
    const record = await this.refreshStatus(speakerId)
    this.afterRemoteStatus(speakerId, record)
    return record
  }

  /** 只做一次远端查询并落库；不碰轮询生命周期，避免与 pollOnce 双向调度形成双定时器。 */
  private async refreshStatus(speakerId: string): Promise<VoiceCloneRecord> {
    const record = await this.findRecord(speakerId)
    if (!record) throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '克隆音色不存在')
    const key = await this.secrets.get('clone')
    if (!key) throw new VoiceError(VOICE_ERROR_CODES.KEY_REQUIRED, '请先保存语音服务 Key')
    const eps = await this.cloneEndpoints()
    const status = await this.provider.getStatus(eps.status, key, speakerId)
    return this.applyRemoteStatus(speakerId, status)
  }

  async activate(input: VoiceCloneActivateInput): Promise<VoiceSpeakResult> {
    const speakerId = String(input?.speakerId ?? '')
    const existing = this.activationInflight.get(speakerId)
    if (existing) return existing
    const task = this.activateOnce(input)
    this.activationInflight.set(speakerId, task)
    try {
      return await task
    } finally {
      this.activationInflight.delete(speakerId)
    }
  }

  private async activateOnce(input: VoiceCloneActivateInput): Promise<VoiceSpeakResult> {
    const record = await this.findRecord(String(input?.speakerId ?? ''))
    if (!record) throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '克隆音色不存在')
    if (record.status !== 'success' && record.status !== 'active') {
      throw new VoiceError(VOICE_ERROR_CODES.CLONE_FAILED, '音色尚未训练完成')
    }
    if (!record.activated && record.expiresAt && record.expiresAt < this.now()) {
      throw new VoiceError(
        VOICE_ERROR_CODES.CLONE_FAILED,
        '该克隆音色已过 7 天保留期，供应商侧可能已删除，请重新训练'
      )
    }
    if (record.activated) {
      return this.voiceManager.speak({
        text: input.text || '你好，我已经可以使用这个声音了。',
        options: { speaker: record.speakerId }
      })
    }
    if (!input.confirmSlotFee) {
      throw new VoiceError(
        VOICE_ERROR_CODES.INVALID_INPUT,
        '首次正式合成将收取音色槽位费，必须明确确认'
      )
    }
    const activationText =
      String(input.text ?? '').trim().slice(0, 60) || '你好，我已经可以使用这个声音了。'
    const result = await this.voiceManager.speakForCloneActivation({
      text: activationText,
      options: { speaker: record.speakerId }
    })
    await this.updateRecord(record.speakerId, {
      status: 'active',
      activated: true,
      activatedAt: this.now(),
      expiresAt: null
    })
    return result
  }

  private voiceDir(speakerId: string): string {
    const dir = resolve(this.voicesDir, speakerId)
    if (!dir.startsWith(`${this.voicesDir}${sep}`)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法音色目录')
    }
    return dir
  }

  /**
   * 本地记录与远端逐条对账。
   *
   * 本地只记录自己创建过的音色，但远端可能已因 7 天未转正被删、训练失败、或已回收。
   * 不核对就会出现「列表里还在，实际早就没了」。
   *
   * 只调 get_voice（这把 Key 有权限的接口），不依赖 AK/SK。
   */
  async reconcile(): Promise<VoiceReconcileItem[]> {
    const records = await this.loadRecords()
    const key = await this.secrets.get('clone')
    if (!key) {
      throw new VoiceError(VOICE_ERROR_CODES.KEY_REQUIRED, '请先保存语音服务 Key')
    }
    const eps = await this.cloneEndpoints()
    const out: VoiceReconcileItem[] = []
    for (const record of records) {
      const item: VoiceReconcileItem = {
        speakerId: record.speakerId,
        displayName: record.displayName,
        localStatus: record.status,
        verdict: 'unknown',
        remoteStatus: null,
        remoteModelTypes: [],
        newModelTypes: [],
        availableTrainingTimes: record.availableTrainingTimes,
        message: ''
      }
      try {
        const status = await this.provider.getStatus(
          eps.status,
          key,
          record.speakerId
        )
        item.remoteStatus = status.status
        item.remoteModelTypes = status.modelTypes.slice()
        item.availableTrainingTimes = status.availableTrainingTimes
        const localModels = new Set(record.modelTypes)
        item.newModelTypes = status.modelTypes.filter((m) => !localModels.has(m))
        if (status.status === 0) {
          item.verdict = 'remote-missing'
          item.message = '远端已不存在（可能超过 7 天未转正被删除，或已被回收）'
        } else if (status.status === 3) {
          item.verdict = 'remote-failed'
          item.message = status.message || '远端训练失败'
        } else {
          const mapped = statusName(status.status)
          // success 与 active 在业务上都表示「可用」，只是本地是否已转正的差别。
          // 按语义等价比较，避免把「远端 Active + 本地 active」误判成已变化。
          const normalize = (v: string): string =>
            v === 'success' || v === 'active' ? 'usable' : v
          if (normalize(mapped) !== normalize(record.status)) {
            item.verdict = 'remote-changed'
            item.message = `远端已是「${mapped}」，本地仍记为「${record.status}」，点刷新即可同步`
          } else if (item.newModelTypes.length) {
            item.verdict = 'remote-changed'
            item.message = `远端新增试听版本 ${item.newModelTypes.join('/')}，点刷新即可下载`
          } else {
            item.verdict = 'remote-ok'
            item.message = '本地与远端一致'
          }
        }
      } catch (error) {
        const code = error instanceof VoiceError ? error.code : ''
        item.remoteStatus = null
        if (code === VOICE_ERROR_CODES.AUTH_ERROR || code === VOICE_ERROR_CODES.KEY_REQUIRED) {
          item.verdict = 'unknown'
          item.message = 'Key 无效或缺失，无法核对'
        } else {
          item.verdict = 'unknown'
          item.message = `查询失败：${safeError(error)}`
        }
      }
      out.push(item)
    }
    return out
  }

  async remove(speakerId: string): Promise<{ removed: true; remoteDelete: 'unsupported' }> {
    const record = await this.findRecord(speakerId)
    if (!record) throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '克隆音色不存在')
    const timer = this.timers.get(speakerId)
    if (timer) clearTimeout(timer)
    this.timers.delete(speakerId)
    const dir = this.voiceDir(speakerId)
    await fs.rm(dir, { recursive: true, force: true })
    const records = await this.loadRecords()
    await this.saveRecords(records.filter((item) => item.speakerId !== speakerId))
    return { removed: true, remoteDelete: 'unsupported' }
  }

  async readDemo(speakerId: string, modelType: number): Promise<{ mime: string; bytes: Uint8Array }> {
    const record = await this.findRecord(speakerId)
    const demo = record?.demos.find((item) => item.modelType === modelType)
    if (!record || !demo) {
      throw new VoiceError(VOICE_ERROR_CODES.NOT_FOUND, '试听音频不存在')
    }
    const fileName = basename(demo.fileName)
    const dir = this.voiceDir(speakerId)
    const path = resolve(dir, fileName)
    if (!path.startsWith(`${dir}${sep}`)) {
      throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '非法试听路径')
    }
    const data = await fs.readFile(path)
    return { mime: demo.mime, bytes: new Uint8Array(data) }
  }
}
