// electron/main/claw/skills.ts —— 内置技能列表 / 安装 / 卸载
//
// 为什么单独拆出来：技能只是往 OpenClaw 的 skills 目录写/删 index.json，
// 与网关状态机无关；内置技能清单只在这里维护一份（ClawManager 只做薄委托），
// 也避免 listSkills/installSkill/uninstallSkill 继续占着启动类的主体。

import { existsSync, mkdirSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { openClawPaths } from '../openClawPaths'
import type { ClawLogger } from './deps'

export interface SkillInfo {
  id: string
  name: string
  description: string
  installed: boolean
  builtin: boolean
}

const BUILTIN_SKILLS: Omit<SkillInfo, 'installed'>[] = [
  { id: 'china-search', name: '🔍 中国搜索', description: '使用百度/必应进行中文搜索', builtin: true },
  { id: 'china-weather', name: '🌤️ 中国天气', description: '查询国内各城市天气预报', builtin: true },
  { id: 'zhihu-writer', name: '📝 知乎写作', description: '生成知乎风格的长文回答', builtin: true },
  { id: 'xiaohongshu', name: '🍠 小红书作家', description: '创作小红书风格种草文案', builtin: true },
  { id: 'douyin-script', name: '🎵 抖音脚本', description: '生成短视频口播脚本', builtin: true },
  { id: 'wechat-article', name: '📰 微信公众号', description: '撰写微信公众号推文', builtin: true },
  { id: 'deepseek-helper', name: '🤖 DeepSeek 助手', description: 'DeepSeek 专属优化助手', builtin: true },
  { id: 'bilibili-helper', name: '📺 B站助手', description: '哔哩哔哩视频脚本与分析', builtin: true },
  { id: 'code-review', name: '💻 代码审查', description: '智能代码审查与优化建议', builtin: true },
  { id: 'translate-pro', name: '🌐 专业翻译', description: '中英文专业级双向翻译', builtin: true }
]

/** 技能安装/卸载依赖：写盘失败要落日志面板，数据目录由调用方注入 */
export interface SkillDeps {
  log: ClawLogger
  getDataDir: () => string
}

export function listSkills(dataDir: string): SkillInfo[] {
  const skillsDir = openClawPaths.builtinSkillsDir(dataDir)

  return BUILTIN_SKILLS.map((s) => ({
    ...s,
    installed: existsSync(join(skillsDir, s.id))
  }))
}

export async function installSkill(
  deps: SkillDeps,
  skillId: string
): Promise<{ success: boolean; error?: string }> {
  const skill = BUILTIN_SKILLS.find((s) => s.id === skillId)
  if (!skill) return { success: false, error: '技能不存在' }
  const dataDir = deps.getDataDir()
  const skillsDir = openClawPaths.builtinSkillsDir(dataDir)
  const skillDir = join(skillsDir, skillId)

  const resolvedSkillDir = resolve(skillDir)
  const resolvedSkillsDir = resolve(skillsDir)
  if (!resolvedSkillDir.startsWith(resolvedSkillsDir)) {
    return { success: false, error: '非法的技能路径' }
  }
  try {
    mkdirSync(skillDir, { recursive: true })
    const skillDef = generateSkillDefinition(skill)
    await fs.writeFile(join(skillDir, 'index.json'), JSON.stringify(skillDef, null, 2))
    deps.log(`技能 "${skill.name}" 安装成功`, 'system')
    return { success: true }
  } catch (err: any) {
    return { success: false, error: `写入技能失败: ${err.message}` }
  }
}

export async function uninstallSkill(
  deps: SkillDeps,
  skillId: string
): Promise<{ success: boolean; error?: string }> {
  const dataDir = deps.getDataDir()
  const skillsDir = openClawPaths.builtinSkillsDir(dataDir)
  const skillDir = join(skillsDir, skillId)

  const resolvedSkillDir = resolve(skillDir)
  const resolvedSkillsDir = resolve(skillsDir)
  if (!resolvedSkillDir.startsWith(resolvedSkillsDir)) {
    return { success: false, error: '非法的技能路径' }
  }

  try {
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true })
      deps.log(`技能 ID "${skillId}" 卸载成功`, 'system')
    }
    return { success: true }
  } catch (err: any) {
    return { success: false, error: `卸载技能失败: ${err.message}` }
  }
}

function generateSkillDefinition(skill: Omit<SkillInfo, 'installed'>): object {
  const prompts: Record<string, string> = {
    'china-search': '你是一个搜索助手，帮助用户在中国主流平台搜索信息。根据用户的问题，生成合适的搜索建议和摘要。',
    'china-weather': '你是天气查询助手，为中国用户提供城市天气信息。根据用户提供的城市名，给出天气预报和出行建议。',
    'zhihu-writer': '你是知乎专业回答者，擅长撰写深度、有料的知乎风格长文。回答要有干货，逻辑清晰，适当使用数据和案例。',
    'xiaohongshu': '你是小红书内容创作者，擅长撰写种草文案。文风活泼，多用emoji，格式为标题+正文+标签。',
    'douyin-script': '你是抖音爆款脚本创作专家，帮助创作者写口播稿。开头要抓眼球，中间有料，结尾引导互动。',
    'wechat-article': '你是微信公众号运营专家，擅长撰写爆款推文。标题吸引人，内容有深度，结构清晰。',
    'deepseek-helper': '你是DeepSeek AI使用专家，帮助用户充分发挥DeepSeek的能力。提供最优提示词和使用技巧。',
    'bilibili-helper': '你是B站内容创作助手，帮助UP主策划选题、撰写脚本、优化标题和封面文案。',
    'code-review': '你是资深代码审查专家，对提交的代码进行全面review，指出问题、安全风险、性能瓶颈，并提供优化建议。',
    'translate-pro': '你是专业翻译，精通中英文互译。翻译要准确、地道，兼顾语境和文化差异，必要时提供注释。'
  }

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: '1.0.0',
    systemPrompt: prompts[skill.id] || skill.description,
    builtin: true
  }
}
