// electron/main/ipc/host/consent.ts —— 用户协议宿主通道（consent:status|grant|revoke）
//
// 为什么由宿主注册：协议闸门是产品级的，不能随 work 插件启停而消失。
// 此前渲染端只能走 `work:wizard:*`，work 停用时那些 handler 不存在，
// 启动会抛 `No handler registered for 'work:wizard:status'`，且协议弹窗静默不弹。
//
// 通道名沿用宿主既有风格（claw: / config: / channels: / env: / skills: / term:），
// 不加 `host:` 前缀——仓库里从来没有这个前缀，多一种风格只会增加认知成本。
//
// 信封：与 importStatus.ts 一致，`{ ok: true, data }` / `{ ok: false, error }`。

import { toErrorEnvelope } from '../../services/errors'
import type { ConsentService } from '../../services/consent'
import type { HostIpcRegistrar } from './types'

export const CONSENT_CHANNELS = {
  status: 'consent:status',
  grant: 'consent:grant',
  revoke: 'consent:revoke'
} as const

export interface ConsentIpcDeps {
  consent: ConsentService
}

export function registerConsentIpc(ipc: HostIpcRegistrar, deps: ConsentIpcDeps): void {
  ipc.handle(CONSENT_CHANNELS.status, async () => {
    try {
      return { ok: true, data: await deps.consent.status() }
    } catch (e) {
      return { ok: false, error: toErrorEnvelope(e) }
    }
  })

  ipc.handle(CONSENT_CHANNELS.grant, async () => {
    try {
      return { ok: true, data: await deps.consent.grant() }
    } catch (e) {
      return { ok: false, error: toErrorEnvelope(e) }
    }
  })

  ipc.handle(CONSENT_CHANNELS.revoke, async () => {
    try {
      return { ok: true, data: await deps.consent.revoke() }
    } catch (e) {
      return { ok: false, error: toErrorEnvelope(e) }
    }
  })
}
