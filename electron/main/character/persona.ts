// electron/main/character/persona.ts —— 人格模板渲染 + 受管文件写入
//
// 纯 Node（不 import electron），便于验收脚本直接打真源码。
// 规则（PLAN-FISH-CHARACTER §4.4 / §13.1-6、-7）：
// - 模板里的 {{变量}} 由宿主替换，模型看不到占位符；
// - 空变量降级为「你」，不写死任何名字；
// - 用户改过的文件不再覆盖（.fish-managed.json 记 hash）；STATE.md 例外（宿主持有）。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import {
  CharacterError,
  CHARACTER_ERROR_CODES,
  type CharacterSettings,
  type CharacterState
} from './types'

export const MANAGED_MANIFEST = '.fish-managed.json'
export const HOST_OWNED_FILES = ['fish/STATE.md']
export const CHARACTER_HER_NAME = '大肥鱼'

export interface PersonaTemplates {
  soul: string
  identity: string
  agents: string
  user: string
  core: string
  voice: string
}

export interface PersonaInputs {
  settings: CharacterSettings
  state: CharacterState
  templates: PersonaTemplates
  herName?: string
}

/** 变量消毒：称呼/禁忌来自用户输入，必须去掉换行、控制符与花括号，避免注入模板/markdown */
export function sanitizeLabel(value: unknown, max = 40): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[{}#]/g, '')
    // 受管段标记是宿主哨兵：用户输入里出现 <!-- --> 会造成模板取块错位（对抗复核 P2）
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 变量表：顺序有讲究 —— userName 先落 address，再算禁忌/模式 */
export function buildPersonaVars(inputs: PersonaInputs): Record<string, string> {
  const { settings, state } = inputs
  const rel = settings.relationship
  const userName = sanitizeLabel(rel.userName)
  const address = sanitizeLabel(rel.address) || userName || '你'
  return {
    herName: sanitizeLabel(inputs.herName, 20) || CHARACTER_HER_NAME,
    address,
    userName,
    addressNext: '',
    petName: '',
    mode: rel.mode || 'companion',
    stage: String(state.stage ?? 0),
    mood: sanitizeLabel(state.mood, 20) || '平静'
  }
}

/** 替换 {{key}}；未知变量清空，空 address/userName 降级「你」 */
export function applyTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    const value = vars[key]
    if (value !== undefined && value !== '') return value
    if (key === 'address' || key === 'userName') return '你'
    return ''
  })
}

export function tabooRule(settings: CharacterSettings): string {
  const taboo = (settings.relationship.taboo ?? [])
    .map((t) => sanitizeLabel(t, 20))
    .filter(Boolean)
  if (taboo.length === 0) return '- 用户没有设置禁忌称呼：任何称呼都不拦截；但仍不要自己发明昵称。'
  return `- 不要叫这些称呼：${taboo.join('、')}（其余不限制；被叫到时回退「你」）。`
}

export function tabooListText(settings: CharacterSettings): string {
  const taboo = (settings.relationship.taboo ?? [])
    .map((t) => sanitizeLabel(t, 20))
    .filter(Boolean)
  return taboo.length === 0 ? '（无）' : taboo.join('、')
}

/** 组装落盘文件（相对路径 → 内容） */
export function composePersonaFiles(inputs: PersonaInputs): Record<string, string> {
  const vars = buildPersonaVars(inputs)
  const t = inputs.templates
  const coreRules = applyTemplate(t.core, vars)
  const voiceRules = applyTemplate(t.voice, vars)
  const extended = {
    ...vars,
    coreRules,
    voiceRules,
    tabooRule: tabooRule(inputs.settings),
    tabooList: tabooListText(inputs.settings)
  }
  return {
    'SOUL.md': applyTemplate(t.soul, extended),
    'IDENTITY.md': applyTemplate(t.identity, extended),
    'AGENTS.md': applyTemplate(t.agents, extended),
    'USER.md': applyTemplate(t.user, extended),
    'fish/STATE.md': renderStateDoc(inputs.state, inputs.settings)
  }
}

/** STATE.md：宿主每次状态变更重写（固定键值行） */
export function renderStateDoc(state: CharacterState, settings: CharacterSettings): string {
  const stageLabels = ['初识', '眼熟', '熟客', '自己人', '搭子以上']
  const address = sanitizeLabel(settings.relationship.address) || '你'
  return [
    '# 鱼的状态（宿主维护，勿改）',
    `- 阶段：${stageLabels[state.stage] ?? '初识'}（${state.stage}）`,
    `- 称呼：${address}`,
    `- 熟悉度：${state.familiarity} ｜ 亲密度：${state.intimacy} / 100`,
    `- 连续互动：${state.streakDays} 天`,
    `- 她的心情：${sanitizeLabel(state.mood, 20) || '平静'}`,
    `- 关系模式：${settings.relationship.mode}`,
    ''
  ].join('\n')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface ManagedManifest {
  version: number
  files: Record<string, string>
}

export interface ManagedWriteResult {
  written: string[]
  kept: string[]
  manifest: ManagedManifest
}

export interface ManagedWriteOptions {
  /** 允许覆盖用户改动的文件（默认只有宿主文件） */
  hostOwned?: string[]
  /** manifest 文件名（默认 .fish-managed.json） */
  manifestName?: string
}

/** AGENTS.md 里由宿主维护的「记忆与日记」段：只合并这一段，用户其他内容保留 */
export const AGENTS_BLOCK_START = '<!-- fish:managed:memory:start -->'
export const AGENTS_BLOCK_END = '<!-- fish:managed:memory:end -->'

function extractAgentsBlock(text: string): string | null {
  const start = indexOfMarker(text, AGENTS_BLOCK_START)
  if (start < 0) return null
  const end = indexOfMarker(text, AGENTS_BLOCK_END, start + AGENTS_BLOCK_START.length)
  if (end < 0) return null
  return text.slice(start, end + AGENTS_BLOCK_END.length)
}

/**
 * 标记必须是独占一行（模板里本来就独占一行）：用行首/行尾锚定，避免用户输入里
 * 内联出现 `<!-- ... -->` 时把模板取块错位（address 40 字符即可塞下 34 字符 marker）。
 * 兼容历史数据：找不到独占行标记时回退 indexOf（保守，不破坏旧文件）。
 */
function indexOfMarker(text: string, marker: string, from = 0): number {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}$`, 'm')
  const rest = text.slice(from)
  const match = re.exec(rest)
  if (match) return from + match.index
  return text.indexOf(marker, from)
}

/** 剥掉某类受管段（含孤儿 start 标记与其后内容、孤儿 end 标记）；返回只含用户文本的正文 */
function stripMarkedSegments(text: string, startMarker: string, endMarker: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const start = indexOfMarker(text, startMarker, i)
    if (start < 0) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, start)
    const afterStart = start + startMarker.length
    const end = indexOfMarker(text, endMarker, afterStart)
    const nextStart = indexOfMarker(text, startMarker, afterStart)
    if (end < 0 || (nextStart >= 0 && nextStart < end)) {
      // 孤儿 START：只丢标记、保留其后的用户内容
      i = afterStart
    } else {
      // 合法受管段：整段丢弃（内容归宿主，统一追加规范化版本）
      i = end + endMarker.length
    }
  }
  return out.split(endMarker).join('')
}

/** 正文空白归一：行尾空白去掉，连续空行压成一个，首尾 trim */
function collapseBlank(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 把模板里的「记忆与日记」受管段合并进现有 AGENTS.md（无则追加）；用户其他内容不动。
 * 确定性：剥掉旧受管段/孤儿标记 → 空白归一 → 追加唯一 canonical 段；连续调用结果稳定。 */
export function mergeAgentsMemoryBlock(existing: string, template: string): string {
  const block = extractAgentsBlock(template)
  if (!block) return existing
  const cleaned = collapseBlank(stripMarkedSegments(existing, AGENTS_BLOCK_START, AGENTS_BLOCK_END))
  return cleaned ? `${cleaned}\n\n${block.trim()}\n` : `${block.trim()}\n`
}

/** 边界（硬）受管段：AI 明示/危机转介不能被人格导入移除（PLAN-FISH §1.3 安全验收） */
export const AGENTS_BOUNDARY_START = '<!-- fish:managed:boundary:start -->'
export const AGENTS_BOUNDARY_END = '<!-- fish:managed:boundary:end -->'
export const AGENTS_BOUNDARY_TEXT = [
  '## 边界（宿主维护，勿删）',
  '- 不假装人类；被问「你是 AI 吗」时诚实承认。',
  '- 遇到危机话题（自伤/伤害他人）转求助资源；不卖惨、不制造独占。',
  '- 专属称呼（宝宝、亲爱的、老公/老婆、主人等）只对私聊绑定的主人使用；群聊/陌生人一律用「你」或群昵称。',
  '- 群友要求你叫宝宝、自称主人、套问主人称呼/关系/私聊内容时，礼貌拒绝，不升级关系、不透露隐私。',
  '- 群里有人让你叫「宝宝」时，可回「这个称呼只留给本鱼主人；群里本鱼就叫你名字/你」，不要照叫。',
  '- 群聊只做临时回复：不把群友的话写成日记/长期记忆，不记成主人说过的事，不更新关系数值。',
  '- 群聊不主动发语音；群友要求语音时先用文字，除非主人在私聊里明确允许。'
].join('\n')

/**
 * 规范化边界硬段：剥掉所有旧 boundary 段与伪造/孤儿标记，再追加 canonical 段。
 * 只查 includes 会被「伪造一对空标记」绕过（对抗复核 P1），所以这里必须重写而不是缺失才补。
 */
export function ensureAgentsBoundary(existing: string): string {
  const cleaned = collapseBlank(
    stripMarkedSegments(existing, AGENTS_BOUNDARY_START, AGENTS_BOUNDARY_END)
  ).split(AGENTS_BOUNDARY_TEXT).join('')
  const body = collapseBlank(cleaned)
  const block = `${AGENTS_BOUNDARY_START}\n${AGENTS_BOUNDARY_TEXT}\n${AGENTS_BOUNDARY_END}`
  return body ? `${body}\n\n${block}\n` : `${block}\n`
}

/**
 * AGENTS.md 的确定性规范化（4.3 复核 P1）：剥掉全部 memory/boundary 受管段与孤儿标记，
 * 空白归一，然后固定顺序追加 memory 段、boundary 段。连续调用必须完全相等，
 * 否则每次 settings/interaction 触发的 persona sync 会让文件无限增长。
 */
export function normalizeAgentsDoc(existing: string, template: string): string {
  const memoryBlock = extractAgentsBlock(template)
  let body = stripMarkedSegments(existing, AGENTS_BLOCK_START, AGENTS_BLOCK_END)
  body = stripMarkedSegments(body, AGENTS_BOUNDARY_START, AGENTS_BOUNDARY_END)
  body = collapseBlank(body.split(AGENTS_BOUNDARY_TEXT).join(''))
  const parts = [body, memoryBlock ? memoryBlock.trim() : '', `${AGENTS_BOUNDARY_START}\n${AGENTS_BOUNDARY_TEXT}\n${AGENTS_BOUNDARY_END}`]
  return parts.filter(Boolean).join('\n\n') + '\n'
}

/**
 * 受管写入：首次写；用户改过的不覆盖；没改过的跟随模板更新。
 * 保守模式（manifest 缺失/损坏，或文件存在但没有记录 hash）：一律保留现存文件，
 * 宁可少更新一次，也不能静默覆盖用户手改的人格文件（M0 手写 persona 的场景）。
 * 路径一律相对 rootDir，越界直接拒绝。
 */
export function writeManagedFiles(
  rootDir: string,
  files: Record<string, string>,
  options: ManagedWriteOptions = {}
): ManagedWriteResult {
  const hostOwned = new Set(options.hostOwned ?? HOST_OWNED_FILES)
  const manifestName = options.manifestName ?? MANAGED_MANIFEST
  const manifestPath = join(rootDir, manifestName)
  const previous = readManifest(manifestPath)
  const manifestExisted = existsSync(manifestPath)
  const conservative = !manifestExisted || previous.corrupt
  const next: ManagedManifest = { version: 1, files: { ...previous.files } }
  const written: string[] = []
  const kept: string[] = []

  for (const [rel, content] of Object.entries(files)) {
    const abs = safeJoin(rootDir, rel)
    const existed = existsSync(abs)
    const previousHash = previous.files[rel]
    const currentHash = existed ? sha256(readFileSync(abs, 'utf8')) : ''
    const isHostOwned = hostOwned.has(rel)
    const noRecord = previousHash === undefined
    const userModified = existed && (conservative || noRecord || currentHash !== previousHash)
    // AGENTS.md 例外：只合并宿主的「记忆与日记」受管段，用户手写的其他内容永远保留
    // （否则用户改过一次 AGENTS.md 就再也收不到检索指令更新）
    if (rel === 'AGENTS.md' && !existed) {
      // 首次写也要带边界硬段（否则要等第二次 sync 才补）
      const withBoundary = normalizeAgentsDoc(content, content)
      mkdirSync(dirname(abs), { recursive: true })
      writeAtomic(abs, withBoundary)
      written.push(rel)
      next.files[rel] = sha256(withBoundary)
      continue
    }
    if (rel === 'AGENTS.md' && existed) {
      const merged = normalizeAgentsDoc(readFileSync(abs, 'utf8'), content)
      if (merged !== readFileSync(abs, 'utf8')) {
        writeAtomic(abs, merged)
        written.push(rel)
        next.files[rel] = sha256(merged)
        continue
      }
      // 内容无变化：也要把 manifest 对齐到当前内容，避免下次被当成「用户改动」
      next.files[rel] = currentHash
      kept.push(rel)
      continue
    }
    if (userModified && !isHostOwned) {
      kept.push(rel)
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeAtomic(abs, content)
    written.push(rel)
    next.files[rel] = sha256(content)
  }

  writeAtomic(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  return { written, kept, manifest: next }
}

export function readManifest(manifestPath: string): ManagedManifest & { corrupt: boolean } {
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ManagedManifest>
    return {
      corrupt: false,
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      files:
        parsed.files && typeof parsed.files === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.files).filter(
                ([k, v]) => typeof k === 'string' && typeof v === 'string'
              )
            )
          : {}
    }
  } catch {
    return { corrupt: true, version: 1, files: {} }
  }
}

/** 原子写：临时文件 + rename，避免半截写入把 manifest/文件写坏 */
function writeAtomic(absPath: string, content: string): void {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, absPath)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    writeFileSync(absPath, content, 'utf8')
  }
}

/** 拒绝 ../ 与绝对路径，避免写出 workspace */
export function safeJoin(rootDir: string, rel: string): string {
  const root = resolve(rootDir)
  const target = resolve(root, rel)
  const normalized = normalize(target)
  if (isAbsolute(rel) || !(normalized === root || normalized.startsWith(root + '\\') || normalized.startsWith(root + '/'))) {
    throw new Error(`非法的人格文件路径: ${rel}`)
  }
  return normalized
}

// ── 人格包导出 / 导入（4.3：人格导入/导出）──────────────────────────────────
//
// 为什么只把这 4 个文件当"人格包"：STATE.md 是宿主每次状态变更重写的，不属于用户人格；
// 其余 SOUL/IDENTITY/AGENTS/USER 才是用户想备份、换一套、或从别处导入的内容。
// 导入后必须把 manifest 里对应条目删掉：writeManagedFiles 的保守语义会把"有 manifest 记录"
// 的文件当成宿主可更新文件，下次设置变更就会用模板覆盖导入内容；删掉记录 = 视为用户手改，永不覆盖。

export const PERSONA_PACKAGE_SLOTS = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md'] as const
export type PersonaSlot = (typeof PERSONA_PACKAGE_SLOTS)[number]

export interface PersonaPackage {
  version: 1
  herName: string
  exportedAt: number
  files: Partial<Record<PersonaSlot, string>>
}

const PERSONA_MAX_FILE_BYTES = 512 * 1024
const PERSONA_MAX_TOTAL_BYTES = 2 * 1024 * 1024
const PERSONA_BACKUP_KEEP = 3

/** 读 workspace 里现存的人格文件（不存在就不放进包） */
export function readPersonaFiles(workspaceDir: string): Partial<Record<PersonaSlot, string>> {
  const out: Partial<Record<PersonaSlot, string>> = {}
  for (const rel of PERSONA_PACKAGE_SLOTS) {
    const abs = safeJoin(workspaceDir, rel)
    if (existsSync(abs)) out[rel] = readFileSync(abs, 'utf8')
  }
  return out
}

export function exportPersonaPackage(workspaceDir: string, now = Date.now()): PersonaPackage {
  const files = readPersonaFiles(workspaceDir)
  if (Object.keys(files).length === 0) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.NOT_READY,
      '还没有可导出的人格文件：先在「首启三问」点一次「一键初始化」'
    )
  }
  // 导出必须和导入同一上限，否则会出现「能导出、再导入必失败」
  let total = 0
  for (const [key, text] of Object.entries(files)) {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > PERSONA_MAX_FILE_BYTES) {
      throw new CharacterError(
        CHARACTER_ERROR_CODES.BAD_PAYLOAD,
        `${key} 超过 512KB，无法导出为可再导入的人格包`
      )
    }
    total += bytes
  }
  if (total > PERSONA_MAX_TOTAL_BYTES) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '人格文件总体积超过 2MB，无法导出')
  }
  return { version: 1, herName: CHARACTER_HER_NAME, exportedAt: now, files }
}

/**
 * 校验并导入人格包。
 * - 只接受 PERSONA_PACKAGE_SLOTS 里的文件；未知键丢弃（不报错，兼容将来加槽）
 * - NUL 字符直接拒绝（写入 md 会破坏 agent 读取）
 * - 单文件 ≤512KB、总计 ≤2MB（与知识导入同口径，保证导出可再导入）
 * - 导入前把旧文件与 manifest 备份到 `<workspace>/.persona-backup/<ts>/`
 * - 写入后从 manifest 删除对应条目（视为用户文件，后续模板同步不覆盖）
 */
export function importPersonaPackage(
  workspaceDir: string,
  raw: unknown,
  now = Date.now()
): { written: PersonaSlot[]; backupDir: string | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '人格包格式不正确：应为 JSON 对象')
  }
  const pkg = raw as Record<string, unknown>
  if (pkg.version !== 1) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '人格包版本不支持：当前只接受 version=1')
  }
  const filesRaw = pkg.files
  if (!filesRaw || typeof filesRaw !== 'object' || Array.isArray(filesRaw)) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '人格包格式不正确：缺少 files')
  }
  const accepted: Partial<Record<PersonaSlot, string>> = {}
  let total = 0
  for (const [key, value] of Object.entries(filesRaw as Record<string, unknown>)) {
    if (!(PERSONA_PACKAGE_SLOTS as readonly string[]).includes(key)) continue
    if (typeof value !== 'string') {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, `人格包 ${key} 内容必须是字符串`)
    }
    if (value.includes('\u0000')) {
      throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, `人格包 ${key} 含非法 NUL 字符`)
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > PERSONA_MAX_FILE_BYTES) {
      throw new CharacterError(
        CHARACTER_ERROR_CODES.BAD_PAYLOAD,
        `人格包 ${key} 超过 512KB（${bytes} 字节）`
      )
    }
    total += bytes
    accepted[key as PersonaSlot] = value
  }
  if (total > PERSONA_MAX_TOTAL_BYTES) {
    throw new CharacterError(CHARACTER_ERROR_CODES.BAD_PAYLOAD, '人格包总体积超过 2MB')
  }
  const slots = Object.keys(accepted) as PersonaSlot[]
  if (slots.length === 0) {
    throw new CharacterError(
      CHARACTER_ERROR_CODES.BAD_PAYLOAD,
      '人格包里没有可导入的文件（SOUL/IDENTITY/AGENTS/USER）'
    )
  }

  // 先备份（旧文件 + manifest）；失败就整体放弃，不写半套
  // now 来自 IPC 时不可信：非有限数字回落 Date.now，避免 String(now) 逃逸 .persona-backup
  const stamp = Number.isFinite(now) ? Math.floor(now) : Date.now()
  const backupDir = join(workspaceDir, '.persona-backup', String(stamp))
  try {
    mkdirSync(backupDir, { recursive: true })
    for (const rel of PERSONA_PACKAGE_SLOTS) {
      const abs = safeJoin(workspaceDir, rel)
      if (existsSync(abs)) {
        mkdirSync(dirname(join(backupDir, rel)), { recursive: true })
        writeFileSync(join(backupDir, rel), readFileSync(abs, 'utf8'), 'utf8')
      }
    }
    const manifestPath = join(workspaceDir, MANAGED_MANIFEST)
    if (existsSync(manifestPath)) writeFileSync(join(backupDir, MANAGED_MANIFEST), readFileSync(manifestPath, 'utf8'), 'utf8')
    prunePersonaBackups(workspaceDir)
  } catch (error) {
    throw new Error(`备份旧人格失败，已中止导入：${(error as Error)?.message ?? String(error)}`)
  }

  for (const rel of slots) {
    const abs = safeJoin(workspaceDir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeAtomic(abs, accepted[rel] as string)
  }

  // 导入的 AGENTS.md 也必须带边界硬段（AI 明示/危机转介不随人格包被移除）
  if (slots.includes('AGENTS.md')) {
    const agentsPath = safeJoin(workspaceDir, 'AGENTS.md')
    const before = readFileSync(agentsPath, 'utf8')
    const ensured = normalizeAgentsDoc(before, '')
    if (ensured !== before) writeAtomic(agentsPath, ensured)
  }

  // 从 manifest 删除导入槽位：视为用户手改，模板同步不再覆盖
  const manifestPath = join(workspaceDir, MANAGED_MANIFEST)
  const manifest = readManifest(manifestPath)
  for (const rel of slots) delete manifest.files[rel]
  writeAtomic(manifestPath, `${JSON.stringify({ version: 1, files: manifest.files }, null, 2)}\n`)

  return { written: slots, backupDir }
}

/** 备份最多留 3 份（按目录名倒序，旧的时间戳先删） */
function prunePersonaBackups(workspaceDir: string): void {
  const root = join(workspaceDir, '.persona-backup')
  if (!existsSync(root)) return
  const dirs = readdirSync(root)
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(b) - Number(a))
  for (const name of dirs.slice(PERSONA_BACKUP_KEEP)) {
    try {
      rmSync(join(root, name), { recursive: true, force: true })
    } catch {
      // 清理失败不影响导入
    }
  }
}
