// electron/main/character/persona.ts —— 人格模板渲染 + 受管文件写入
//
// 纯 Node（不 import electron），便于验收脚本直接打真源码。
// 规则（PLAN-FISH-CHARACTER §4.4 / §13.1-6、-7）：
// - 模板里的 {{变量}} 由宿主替换，模型看不到占位符；
// - 空变量降级为「你」，不写死任何名字；
// - 用户改过的文件不再覆盖（.fish-managed.json 记 hash）；STATE.md 例外（宿主持有）。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { CharacterSettings, CharacterState } from './types'

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
