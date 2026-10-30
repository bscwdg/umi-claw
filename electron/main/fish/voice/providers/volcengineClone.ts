import { randomUUID } from 'crypto'
import { VOICE_ERROR_CODES, VoiceError } from '../core/errors'
import { defaultDemoText, normalizeCloneLanguage } from '../core/cloneLanguage'

type FetchLike = typeof fetch

export interface CloneTrainRequest {
  endpoint: string
  apiKey: string
  customSpeakerId: string
  audioBase64: string
  format: string
  text?: string
  language: number
  /** 试听文本；官方要求与 language 同语种，否则合成失败。缺省按语种取内置短句。 */
  demoText?: string
  /** 样本噪声较大时建议开启；官方 1.0 默认 true、2.0 默认 false。 */
  enableAudioDenoise?: boolean
  /** 关闭音量归一化；关闭后合成音量更贴近样本，相似度更高。 */
  disableVolumeNormalization?: boolean
}

export interface CloneDemoInfo {
  modelType: number
  demoAudio: string
}

export interface CloneProviderStatus {
  code: number
  message: string
  status: number
  modelTypes: number[]
  demos: CloneDemoInfo[]
  availableTrainingTimes: number | null
  /** 响应头 X-Tt-Logid，报障定位用；只进脱敏诊断日志，不进页面。 */
  logId: string | null
}

/**
 * 供应商错误码/报文 → 人能看懂的一句话（UI 只展示这句 + 原始 code）。
 * 供应商原始 message 多为英文技术词（如 `[resource_id=volc.megatts.timbre] requested resource not granted`），
 * 直接透给用户既看不懂、也不知道该去控制台做什么；这里按官方错误码表映射成可执行提示，
 * 并在括号里保留原始信息便于报障。
 */
function humanizeFailure(code: number, message: string): string {
  const raw = String(message ?? '').trim()
  // 网关资源授权失败：不是样本/参数问题，是这把 Key 所属账号（或项目）没拿到声音复刻资源。
  // 控制台开通入口（2026-10-30 实测）：声音复刻2.0 已开通、但音色槽位未开通时，
  // train / get_voice 均返回 HTTP 403 `[resource_id=volc.megatts.timbre] requested resource not granted`。
  if (/requested resource not granted/i.test(raw)) {
    return (
      '语音服务未授予「声音复刻」资源（volc.megatts.timbre）：请到火山引擎控制台确认「声音复刻2.0」与「音色槽位」均已开通' +
      '（语音技术 → 开通管理：https://console.volcengine.com/speech/new/setting/activate?projectName=default），' +
      '并用该账号下具备该资源的 API Key 重试' +
      (raw ? `（原始信息：${raw}）` : '')
    )
  }
  const hints: Record<number, string> = {
    45001101: '音频上传失败，请检查网络与文件后重试',
    45001102: '样本转写失败，请换清晰、单人、人声占比高的样本',
    45001104: '声纹检测未通过，请更换音频或确认已取得声音权利人授权',
    45001105: '音频数据读取失败，请确认文件未损坏、格式正确',
    45001109: '参考文本与样本不一致（WER 检测失败），请删除「样本对应文字」或改成与录音一致的内容',
    45001112: '样本信噪比过低，请换更干净的录音',
    45001113: '降噪处理失败，可尝试关闭降噪后重试',
    45001114: '音频质量不达标，请换 15–30 秒清晰、单人、无背景音乐的样本',
    45001122: '样本里没有检测到清晰人声',
    45001123: '该音色的复刻次数已用完，请更换音色或按控制台额度处理',
    45001124: '样本转写文本未通过内容审核',
    45001125: '试听文本未通过内容审核',
    45001126: '试听文本长度不合规（需 4–300 字）',
    45001127: '样本音频未通过内容审核',
    45001128: '样本与参考文本未通过内容审核'
  }
  const hint = hints[code]
  if (hint) return raw ? `${hint}（${code}：${raw}）` : `${hint}（${code}）`
  if (raw) return raw
  return `声音复刻请求失败（${code || '未知错误码'}）`
}

function providerError(code: number, message: string, status?: number): VoiceError {
  if (code === 401) {
    return new VoiceError(VOICE_ERROR_CODES.AUTH_ERROR, '语音服务鉴权失败，请检查 Key', {
      providerCode: code
    })
  }
  return new VoiceError(VOICE_ERROR_CODES.CLONE_FAILED, humanizeFailure(code, message), {
    providerCode: code,
    status,
    providerMessage: message
  })
}

export class VolcengineCloneProvider {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private parseBody(text: string): Record<string, unknown> {
    if (!text.trim()) return {}
    try {
      const parsed = JSON.parse(text) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  private parseStatus(
    parsed: Record<string, unknown>,
    fallbackMessage = '',
    logId: string | null = null
  ): CloneProviderStatus {
    const status = Number(parsed.status ?? 0)
    const speakerStatus = Array.isArray(parsed.speaker_status) ? parsed.speaker_status : []
    const demos: CloneDemoInfo[] = []
    const modelTypes: number[] = []
    for (const item of speakerStatus) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      const modelType = Number(obj.model_type ?? 0)
      if (modelType > 0 && !modelTypes.includes(modelType)) modelTypes.push(modelType)
      if (modelType > 0 && typeof obj.demo_audio === 'string' && obj.demo_audio) {
        demos.push({ modelType, demoAudio: obj.demo_audio })
      }
    }
    return {
      code: Number(parsed.code ?? 0),
      message: String(parsed.message ?? fallbackMessage ?? ''),
      status: Number.isFinite(status) ? status : 0,
      modelTypes,
      demos,
      availableTrainingTimes:
        parsed.available_training_times === undefined
          ? null
          : Number(parsed.available_training_times),
      logId
    }
  }

  private async post(
    endpoint: string,
    apiKey: string,
    body: unknown,
    timeoutMs: number
  ): Promise<{
    response: Response
    parsed: Record<string, unknown>
    text: string
    logId: string | null
  }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Api-Request-Id': randomUUID()
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const text = await response.text().catch(() => '')
      // 官方建议保存 X-Tt-Logid 便于定位问题；只在内部传递与脱敏日志使用。
      const logId = response.headers.get('x-tt-logid')
      return { response, parsed: this.parseBody(text), text, logId }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new VoiceError(VOICE_ERROR_CODES.TIMEOUT, '声音复刻请求超时')
      }
      throw new VoiceError(
        VOICE_ERROR_CODES.CLONE_FAILED,
        error instanceof Error ? error.message : '声音复刻请求失败'
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async train(request: CloneTrainRequest): Promise<CloneProviderStatus> {
    const language = normalizeCloneLanguage(request.language)
    const { response, parsed, text, logId } = await this.post(
      request.endpoint,
      request.apiKey,
      {
        speaker_id: 'custom_speaker_id',
        custom_speaker_id: request.customSpeakerId,
        audio: {
          format: request.format,
          data: request.audioBase64
        },
        ...(request.text ? { text: request.text } : {}),
        language,
        // 官方《声音复刻API-V3》（当前版）extra_params 只列这三个字段：
        //   demo_text / enable_audio_denoise / disable_volume_normalization
        // 旧实现里的 voice_clone_enable_mss、enable_crop_by_asr、
        // voice_clone_denoise_model_id 已不在文档内，继续发送可能被忽略或报参数错，故移除。
        extra_params: {
          demo_text: request.demoText?.trim() || defaultDemoText(language),
          enable_audio_denoise: request.enableAudioDenoise === true,
          // 关闭音量归一化后，合成音量更贴近样本，与 prompt 相似度更高。
          disable_volume_normalization: request.disableVolumeNormalization === true
        }
      },
      60_000
    )
    const code = Number(parsed.code ?? 0)
    if (!response.ok || (code !== 0 && code !== 200)) {
      throw providerError(code || response.status, String(parsed.message ?? text), response.status)
    }
    return this.parseStatus(parsed, '', logId)
  }

  async getStatus(
    endpoint: string,
    apiKey: string,
    customSpeakerId: string
  ): Promise<CloneProviderStatus> {
    const { response, parsed, text, logId } = await this.post(
      endpoint,
      apiKey,
      {
        speaker_id: 'custom_speaker_id',
        custom_speaker_id: customSpeakerId
      },
      15_000
    )
    const code = Number(parsed.code ?? 0)
    if (!response.ok || (code !== 0 && code !== 200 && code !== 45001107)) {
      throw providerError(code || response.status, String(parsed.message ?? text), response.status)
    }
    return this.parseStatus(parsed, '', logId)
  }

  async testAuth(endpoint: string, apiKey: string): Promise<{ message: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    const customId = `umi_authcheck_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Api-Request-Id': randomUUID()
        },
        body: JSON.stringify({
          speaker_id: 'custom_speaker_id',
          custom_speaker_id: customId
        }),
        signal: controller.signal
      })
      const text = await response.text().catch(() => '')
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null
      } catch {
        parsed = null
      }
      const code = Number(parsed?.code ?? 0)
      if (response.status === 401 || code === 401) {
        throw new VoiceError(VOICE_ERROR_CODES.AUTH_ERROR, '语音服务鉴权失败，请检查 Key')
      }
      // 鉴权通过时，不存在的临时 SpeakerID 会返回 45001107 或等价的业务错误。
      // 仅在「HTTP 成功 + 业务码正常」或「45001107 SpeakerID 未找到」时算通过：
      // 只看 HTTP 200 会把「Key 有效但没被授予声音复刻资源」也误报成鉴权通过。
      const bodyOk = code === 0 || code === 200
      if ((response.ok && bodyOk) || code === 45001107) {
        return { message: '语音服务鉴权通过' }
      }
      const rawMessage = String(parsed?.message ?? text.slice(0, 300) ?? '').trim()
      throw new VoiceError(
        VOICE_ERROR_CODES.PROVIDER_ERROR,
        `语音服务测试未通过：${humanizeFailure(code, rawMessage)}`,
        { providerCode: code, status: response.status, providerMessage: rawMessage }
      )
    } catch (error) {
      if (error instanceof VoiceError) throw error
      if (controller.signal.aborted) {
        throw new VoiceError(VOICE_ERROR_CODES.TIMEOUT, '语音服务鉴权超时')
      }
      throw new VoiceError(
        VOICE_ERROR_CODES.PROVIDER_ERROR,
        error instanceof Error ? error.message : '语音服务鉴权失败'
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
