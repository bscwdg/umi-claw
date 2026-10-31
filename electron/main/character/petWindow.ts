// electron/main/character/petWindow.ts —— 桌宠透明窗口（C03）
//
// 约束（PLAN-FISH-CHARACTER §3.2 / §13.1-2）：
// - 独立 renderer 入口（同一 index.html，路由 #/character-pet，App.vue 走裸布局）；
// - 单例、透明、无边框、置顶、不进任务栏；位置记忆到 fish:v2:pet；
// - 点击穿透必须留逃生口（页面开关 + 全局热键在 wiring 侧注册）；
// - 关主窗/停用角色时必须销毁，避免进程残留。

import { BrowserWindow, Menu, screen } from 'electron'
import { clampPetPosition, type CharacterPetState } from './types'

export type PetMenuAction = 'chat' | 'settings' | 'quiet' | 'hide'

export interface PetWindowOptions {
  preloadPath: string
  /** 开发态渲染端地址（ELECTRON_RENDERER_URL） */
  devRendererUrl?: string
  /** 生产态完整地址（app://renderer/index.html#/character-pet） */
  prodRendererUrl: string
  initialState: CharacterPetState
  onPositionChange: (x: number, y: number) => void
  onAction: (action: PetMenuAction) => void
  onClosed?: () => void
}

export class PetWindowController {
  private win: BrowserWindow | null = null
  private state: CharacterPetState
  private moveTimer: NodeJS.Timeout | null = null
  private destroyed = false

  constructor(private readonly options: PetWindowOptions) {
    this.state = options.initialState
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  /** 向桌宠渲染端广播事件（情绪/气泡等） */
  broadcast(channel: string, payload: unknown): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send(channel, payload)
  }

  getState(): CharacterPetState {
    return { ...this.state }
  }

  /** 首次显示；已存在则只 show/定位 */
  show(): void {
    if (this.destroyed) return
    if (!this.win || this.win.isDestroyed()) {
      this.create()
    }
    const win = this.win
    if (!win || win.isDestroyed()) return
    const target = this.resolveBounds()
    win.setBounds(target)
    win.showInactive()
    win.setAlwaysOnTop(true, 'floating')
    this.applyClickThrough(this.state.clickThrough)
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  toggle(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) this.show()
    else this.hide()
  }

  applyClickThrough(on: boolean): void {
    this.state.clickThrough = on
    if (!this.win || this.win.isDestroyed()) return
    if (on) this.win.setIgnoreMouseEvents(true, { forward: true })
    else this.win.setIgnoreMouseEvents(false)
  }

  /** 设置变化（启用/可见/大小/穿透）时同步窗口 */
  applyState(next: Partial<CharacterPetState>): void {
    const merged: CharacterPetState = {
      ...this.state,
      ...next,
      width: next.width ?? this.state.width,
      height: next.height ?? this.state.height
    }
    this.state = merged
    if (!this.win || this.win.isDestroyed()) {
      if (merged.visible) this.show()
      return
    }
    this.win.setBounds({
      x: this.state.x,
      y: this.state.y,
      width: merged.width,
      height: merged.height
    })
    this.applyClickThrough(merged.clickThrough)
    if (merged.visible && !this.win.isVisible()) this.win.showInactive()
    if (!merged.visible && this.win.isVisible()) this.win.hide()
  }

  destroy(): void {
    this.destroyed = true
    if (this.moveTimer) clearTimeout(this.moveTimer)
    this.moveTimer = null
    if (this.win && !this.win.isDestroyed()) {
      const win = this.win
      this.win = null
      win.destroy()
    }
    this.win = null
  }

  private create(): void {
    const bounds = this.resolveBounds()
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: '大肥鱼',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.win = win
    win.setAlwaysOnTop(true, 'floating')

    // 拖动结束后落库（防抖，避免每像素写一次）
    win.on('moved', () => {
      if (this.moveTimer) clearTimeout(this.moveTimer)
      this.moveTimer = setTimeout(() => {
        if (!this.win || this.win.isDestroyed()) return
        const [x, y] = this.win.getPosition()
        this.state.x = x
        this.state.y = y
        this.options.onPositionChange(x, y)
      }, 800)
    })

    win.webContents.on('context-menu', () => {
      this.popupMenu()
    })

    win.on('closed', () => {
      this.win = null
      this.options.onClosed?.()
    })

    const url =
      this.options.devRendererUrl && !this.options.devRendererUrl.endsWith('#')
        ? `${this.options.devRendererUrl}#/character-pet`
        : this.options.prodRendererUrl
    void win.loadURL(url)
    this.applyClickThrough(this.state.clickThrough)
  }

  private popupMenu(): void {
    const menu = Menu.buildFromTemplate([
      { label: '聊两句', click: () => this.options.onAction('chat') },
      { label: '设置', click: () => this.options.onAction('settings') },
      { type: 'separator' },
      { label: '安静几天', click: () => this.options.onAction('quiet') },
      { label: '收起', click: () => this.options.onAction('hide') }
    ])
    menu.popup()
  }

  /** 位置未记录（0,0）时放在主屏右下角；否则夹到当前屏幕工作区 */
  private resolveBounds(): { x: number; y: number; width: number; height: number } {
    const { width, height } = this.state
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    const near = displays.find(
      (d) =>
        this.state.x >= d.bounds.x &&
        this.state.x < d.bounds.x + d.bounds.width &&
        this.state.y >= d.bounds.y &&
        this.state.y < d.bounds.y + d.bounds.height
    )
    const workArea = (near ?? primary).workArea
    const unset = this.state.x === 0 && this.state.y === 0
    const raw = unset
      ? {
          x: workArea.x + workArea.width - width - 24,
          y: workArea.y + workArea.height - height - 24
        }
      : { x: this.state.x, y: this.state.y }
    const clamped = clampPetPosition(raw.x, raw.y, width, height, workArea)
    this.state.x = clamped.x
    this.state.y = clamped.y
    return { x: clamped.x, y: clamped.y, width, height }
  }
}
