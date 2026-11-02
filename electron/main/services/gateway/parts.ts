// electron/main/services/gateway/parts.ts —— Gateway 消息部件（纯函数，4.1 WP6-a 下沉）
//
// 为什么抽出来：两个 marketing 域 Manager（contentManager / scanRecognizer）要构多模态
// 请求体，原来直接 import 宿主 `electron/main/gatewayClient` 的值导出 → 插件边界越界。
// 这些函数只依赖 errors、不依赖 GatewayClient，放到 services/ 后插件可经白名单使用。

import { AppError, ERROR_CODES } from '../errors'

/** abort（用户点「停止生成」）在 `details.reason` 上的判别值 —— §五 无专用码 */
export const GATEWAY_ABORT_REASON = 'aborted'

export type GatewayContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export function textPart(text: string): GatewayContentPart {
  return { type: 'text', text: String(text ?? '') }
}

/**
 * 图片部件（data URI）。
 *
 * 为什么默认走 data URI：OpenClaw 的 `gateway.http.endpoints.chatCompletions.images.allowUrl`
 * **默认 false**（「data URIs remain supported」），传 http(s) 链接会被网关拒绝；
 * 05b 的扫描件识别必须用 base64 内联。
 */
export function imageDataPart(dataUri: string): GatewayContentPart {
  const url = typeof dataUri === 'string' ? dataUri.trim() : ''
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '图片必须是 data:image/*;base64,... 形式的 data URI', {
      field: 'image_url.url',
      reason: 'invalid-image-data-uri'
    })
  }
  return { type: 'image_url', image_url: { url } }
}

/** 图片部件（外链）。默认网关 **不允许** 服务端拉取 URL，故这里只做形态校验 + 由调用方自担风险 */
export function imageUrlPart(url: string): GatewayContentPart {
  const value = typeof url === 'string' ? url.trim() : ''
  if (!/^https?:\/\//i.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, '图片 URL 必须是 http(s) 地址', {
      field: 'image_url.url',
      reason: 'invalid-image-url'
    })
  }
  return { type: 'image_url', image_url: { url: value } }
}
