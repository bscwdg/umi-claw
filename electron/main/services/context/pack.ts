// electron/main/services/context/pack.ts —— Context Pack 的共享小工具
//
// 下沉依据（WP2）：两域的 shortTitle 逐字相同（dropped 列表里的标题截断）。
//
// **不要顺手把 requireWindow 搬进来**：两域实现不同（work 只有两条文案；
// marketing 接受 field 并带 details），那是有意的差异，不是重复。
//
// 改这里会同时影响两域的 dropped 展示。

import { DROPPED_TITLE_MAX_CHARS } from './limits'

/** dropped 列表里的标题截断：压空白、超长加省略号 */
export function shortTitle(title: string): string {
  const t = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > DROPPED_TITLE_MAX_CHARS ? t.slice(0, DROPPED_TITLE_MAX_CHARS) + '…' : t
}
