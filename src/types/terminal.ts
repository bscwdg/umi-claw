/**
 * 终端命令运行时类型。
 * 'openclaw' — 默认，命令拼到 openclaw 主入口后执行
 * 'npx' — 命令拼到便携 npx-cli 后执行（企微官方安装向导等 npm 包命令）
 */
export type TerminalRuntime = 'openclaw' | 'npx'
