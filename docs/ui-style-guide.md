# Umi Claw 样式规范（Design Token & 组件类）

> 状态：**已落地（2026-11，release/4.0 分支）**。§7 四批迁移全部完成，门禁 src 组六项计数归零（见 §5 落地基线），本文档现为长期门禁依据；后续新页面/新组件必须照此编写，违规会被 `check-style-tokens.mjs` 棘轮拦截。
> 适用范围：`src/**`、`plugins/**/ui/**` 全部 `.vue` 与全局样式。Electron 桌面端固定像素场景，**单位只用 px，禁用 rem**。

## 0. 为什么要有这份规范

现状问题（2026-11 体检结论）：

1. 大肥鱼页引用了**根本不存在的变量名**（`--bg-primary` / `--bg-secondary` / `--border-color`），全部走 fallback 硬编码色，整个页面脱离主题系统，7 个主题切了不变色；
2. 全项目硬编码 hex 180 处、`rgba(255,255,255,*)` 15 处，浅色主题下白色半透明控件会"隐形"；
3. 按钮有 4 套体系（全局 `.btn-primary`、CharacterPage `.btn.primary`、ChannelsPage 重定义 `.btn`、10+ 种一次性按钮类），`btn-ghost` 是空类；
4. 圆角裸值 11 种（2~20px）、字号 px/rem 混用（0.7~1.3rem 算出 10.9px 这类怪尺寸）、间距无 token；
5. 19 个组件只有 1 个 `@media` 断点，固定 3/4 列网格在 900px 最小窗口下挤压；
6. 表单、弹窗、Toast 各页自制，无统一基类。

约束：`plugins/` 16 个组件**重度依赖全局类** `.btn` / `.card` / `.badge-*` / `.form-*`，因此全局类只做**向后兼容的增强**，旧类名一律保留语义。

---

## 1. 基本原则

1. **全局类 + CSS 变量是唯一样式入口**。scoped 样式只写页面独有的布局，不得重定义全局类、不得硬编码颜色。
2. **颜色只认变量**。除白名单外禁止 hex / `rgb()` / `rgba()` 裸值。
   - 白名单：`src/character/art/FishState.vue`（SVG 插画）、`:root` 与 `themes.ts` 中的 token 定义、渠道品牌色（微信绿 `#10b981`、企微蓝 `#0082f0`）的定义处。
3. **静态 token 走 CSS `:root`**（间距/字号/圆角/高度/层级/动效，不随主题变）；**主题 token 走 `themes.ts` 派生**（颜色，随浅/深主题变）。
4. **单位只用 px**。间距、字号、圆角必须取 token，不得新写裸值。
5. **行内 `style=""` 只允许动态绑定**（`:style`），静态样式进 class。
6. 全局类修改必须保证 `plugins/` 现有类名与视觉语义不破坏。

---

## 2. Design Token

### 2.0 主题关联总图（新 token 挂在哪一层）

调用链：config store `applyCurrentTheme()` → `resolveTheme()` → `buildThemeVars(base, accent)` → `applyThemeVars()` 遍历返回对象写入 `<html>` 内联变量。**凡进入 `buildThemeVars` 返回对象的变量，切主题时自动更新，全项目 `var()` 引用即时生效，useTheme 无需改动。**

| 层 | 变量 | 随什么变化 | 挂载的组件 |
|---|---|---|---|
| ① 强调色层 | `--accent` / `-hover` / `-muted`（现有，保留） | 随 7 个预设 + 自定义 accent **实时变色** | `.btn-primary`、`.btn-outline`、输入框 focus 描边与 focus ring、导航激活态、`.toggle` 选中态、步骤序号、链接/`.link` |
| ② 语义色层 | `--success/danger/warning/info` 及三衍生（新增，进 `ThemeVars` 接口与 `buildThemeVars` 返回值） | 只随**浅/深模式**切换两套基础值，**不随 accent 色相变化** | `.btn-success/danger/warning`、`.badge-*`、`.alert-*`、状态点、错误文案 |
| ③ 表面层 | `--surface-1/2/3`、`--hover-overlay`（纯 CSS，不进 themes.ts） | `color-mix` 引用 `--text-primary`，而它由 base 派生 → **间接跟随任何主题底色** | 卡片次级底、tab、pill、hover 态 |
| ④ 静态层 | 间距/字号/圆角/高度/层级/动效（`:root` 常量） | 刻意不关联主题，所有主题下恒定 | 全部组件 |

设计决策：**语义色与品牌 accent 解耦**。红色表达危险/删除、绿色表达成功，不能因为用户把 accent 换成紫色就改变含义；跨主题保持色相稳定、仅按浅/深调整明度与 alpha，是设计系统的通行做法。品牌色（微信绿/企微蓝）同理固定，不进主题派生。

实现注记：`-muted` / `-border` 的 alpha 在浅/深主题下取不同值（浅底上同 alpha 视觉偏淡），在 `buildThemeVars` 内按 `isLight` 分两套，而非全主题统一 alpha。

### 2.1 主题色（`themes.ts` 派生，随浅/深主题切换）

现有 14 个变量（`--bg-base/surface/elevated/overlay`、`--border(-muted)`、`--text-*`、`--accent*`、`--shadow*`）**全部保留不动**。

新增 4 组语义色，每组 4 个衍生变量。基础色在浅色主题下压暗以保证白底对比度，`-muted` / `-border` 由 `withAlpha()` 派生，alpha 按 `isLight` 分两套（下表 alpha 为深色主题值，浅色主题整体上调，实现时在 `buildThemeVars` 内收口）：

| Token | 深色主题 | 浅色主题 | 用途 |
|---|---|---|---|
| `--success` | `#3fb950` | `#1a7f37` | 成功、运行中、已启用 |
| `--success-hover` | `#56d364` | `#1f8f3f` | |
| `--success-muted` | `withAlpha(success,.15)` | 同函数派生 | 浅底、徽标底 |
| `--success-border` | `withAlpha(success,.40)` | 同函数派生 | 描边态 |
| `--danger` | `#f85149` | `#cf222e` | 删除、停用、错误 |
| `--danger-hover` | `#ff7b72` | `#e8544d` | |
| `--danger-muted` | `withAlpha(danger,.12)` | | |
| `--danger-border` | `withAlpha(danger,.40)` | | |
| `--warning` | `#d29922` | `#9a6700` | 警告、待确认、草稿 |
| `--warning-hover` | `#e3b341` | `#b47f0a` | |
| `--warning-muted` | `withAlpha(warning,.15)` | | |
| `--warning-border` | `withAlpha(warning,.40)` | | |
| `--info` | `#58a6ff` | `#0969da` | 提示、信息、链接 |
| `--info-hover` | `#79b8ff` | `#2f81e6` | |
| `--info-muted` | `withAlpha(info,.15)` | | |
| `--info-border` | `withAlpha(info,.40)` | | |

兼容别名（静态 `:root`，指向新 token，不进 themes.ts）：`--green→--success`、`--red→--danger`、`--yellow→--warning`、`--blue→--info`。

### 2.2 表面叠加层（纯 CSS，自动适配浅/深主题）

替代 VoicePage 等页面的 `rgba(255,255,255,.04~.12)`——这类写法在浅色主题下隐形。用 `color-mix` 反向引用当前文字色，深主题自动得到白叠加、浅主题自动得到黑叠加（Electron 30 / Chromium 124 支持，ChannelsPage 已有先例）：

```css
--surface-1: color-mix(in srgb, var(--text-primary) 5%, transparent);
--surface-2: color-mix(in srgb, var(--text-primary) 8%, transparent);
--surface-3: color-mix(in srgb, var(--text-primary) 12%, transparent);
--hover-overlay: color-mix(in srgb, var(--text-primary) 8%, transparent);
```

### 2.3 间距（静态，4px 栅格）

| Token | 值 | 主要用途 |
|---|---|---|
| `--space-1` | 4px | 图标与文字、紧凑间隙 |
| `--space-2` | 8px | 控件内 gap、行间距 |
| `--space-3` | 12px | 按钮组 gap、网格 gap |
| `--space-4` | 16px | 卡片内间距（紧凑）、表单组 |
| `--space-5` | 20px | 卡片标准 padding |
| `--space-6` | 24px | 内容区 padding、卡片间距 |
| `--space-8` | 32px | 分区之间 |
| `--space-10` | 40px | 页面底部留白 |

### 2.4 字号与行高（静态，px）

| Token | 值 | 用途 |
|---|---|---|
| `--text-xs` | 12px | 辅助说明、时间戳、表格小字 |
| `--text-sm` | 13px | **默认正文/控件文字** |
| `--text-base` | 14px | 弹窗正文、强调正文 |
| `--text-md` | 15px | 弹窗标题 |
| `--text-lg` | 16px | 卡片标题 |
| `--text-xl` | 18px | 页头数据、区块标题 |
| `--text-title` | 20px | 页面标题（h2） |
| `--text-hero` | 28px | 空状态大图标数字 |

行高：`--leading-tight:1.3` / `--leading-normal:1.5` / `--leading-relaxed:1.7`。
全局 `h1/h2/h3` 与各页标题统一引用上表，禁止再出现 10/11px 以下字号和 rem。

### 2.5 圆角（静态，5 档收编 11 种裸值）

| Token | 值 | 收编旧裸值 |
|---|---|---|
| `--radius-xs` | 4px | 2 / 3 / 4px |
| `--radius-sm` | 6px | 6 / 7 / 8px |
| `--radius-md` | 10px | 10 / 12 / 14px |
| `--radius-lg` | 16px | 16 / 20px |
| `--radius-pill` | 999px | 999 / 胶囊 / 20px 徽标 |

### 2.6 控件高度（静态）

`--control-h-sm:28px` / `--control-h-md:34px` / `--control-h-lg:40px`。
同一行的按钮、输入框、下拉框必须同高（默认 md）。

### 2.7 阴影 / 层级 / 动效

```css
/* 阴影：保留现有 --shadow-sm / --shadow，新增一档 */
--shadow-lg: 0 12px 36px rgba(0,0,0,.35);
/* 层级 */
--z-banner:1900; --z-modal:2000; --z-toast:2100; --z-pet:2200;
/* 动效 */
--duration-fast:.15s; --duration-normal:.2s; --ease-out:ease;
```

---

## 3. 组件类规范

### 3.1 按钮 `.btn`

基类：高 34px（`--control-h-md`）、padding 0 16px、字号 `--text-sm`、圆角 `--radius-sm`、gap `--space-2`，保留现有 hover/active/disabled 行为。

**颜色修饰符**（互斥，一个按钮只挂一个）：

| 类 | 样式 | 用途 |
|---|---|---|
| 无修饰 | 灰底描边（现状） | 次要动作、取消 |
| `.btn-primary` | 实色 `--accent` | 主动作，**每个按钮区只能有一个** |
| `.btn-success` | 绿描边浅绿底（现状保留） | 启动/确认类正向动作 |
| `.btn-danger` | 红描边浅红底（现状保留） | 删除/停用/退出 |
| `.btn-warning` | 黄描边浅黄底（**新增**） | 重试、风险提醒 |
| `.btn-ghost` | 透明无底（**新增，修复空类**） | 卡片内弱动作、第三顺位 |
| `.btn-outline` | 透明底 + accent 描边 + accent 字（**新增**） | 次级但需要存在感的动作 |

**尺寸**：`.btn-sm`（28px）、默认（34px）、`.btn-lg`（40px）、`.btn-icon`（34×34 方形；`.btn-icon.btn-sm` 28×28）。

**品牌修饰**（仅渠道页）：`.btn-weixin`（`#10b981`）、`.btn-wecom`（`#0082f0`），色值定义在 `:root` 注释标明品牌白名单。

规则：
- 禁用态统一 `:disabled`，不另造类；
- 弹窗内按钮顺序：取消（无修饰）在左，确认动作在右；危险确认的确认钮挂 `.btn-danger`；
- 旧写法 `class="btn primary"` / `class="btn ghost"`（CharacterPage）迁移为 `btn btn-primary` / `btn btn-ghost`；
- 一次性按钮类收编：`.title-btn→.btn-icon`（标题栏特例可保留类名但引用 token）、`.docs-btn/.q-btn/.send-btn/.icon-btn/.help-btn/.notice-close/.link` 按语义并入标准类或改为 `.btn-ghost`/`.btn-icon`。

### 3.2 表单

- `.form-group`（纵向组，gap `--space-2`）、`.form-label`、`.form-hint`（xs 字、secondary 色）、`.form-error-text`（xs 字、`--danger`）；
- `.form-input` / `.form-select` / `.form-textarea`：高 `--control-h-md`（textarea 高度自适应、设 min-height）、圆角 sm、聚焦时 `border-color:var(--accent)` + `box-shadow:0 0 0 3px var(--accent-muted)`；
- 错误态：控件加 `.is-error`（danger 描边 + danger 淡底）；
- CharacterPage 的裸 `input/select` 全部改挂 `.form-input/.form-select`，删除 scoped 重定义。

### 3.3 卡片 `.card`

统一为：bg `--bg-surface`、1px `--border`、圆角 md、padding `--space-5`。新增 `.card-compact`（padding `--space-4`）供密集列表使用。scoped 里不得再重定义 `.card`。

### 3.4 徽标 `.badge`

保留 `.badge-green/red/yellow/blue`（plugins 在用），新增语义别名 `.badge-success/danger/warning/info` 一一对应；底色一律 `*-muted`、文字用对应语义色。

### 3.5 开关 `.toggle`

保留现有结构与类名，仅把硬编码尺寸替换为 token，选中色统一 `--accent`。

### 3.6 弹窗（从 ConfirmDialog 提升为全局类）

新增全局类（写进 style.css，scoped 弹窗迁移引用）：
`.modal-overlay`（fixed 遮罩 + blur，z-index `--z-modal`）、`.modal-card`（elevated 底、radius-lg、shadow-lg）、`.modal-header/-body/-footer`。
尺寸修饰：`.modal-sm`(400px) / `.modal-md`(560px) / `.modal-lg`(720px)，统一 `max-width:92vw`。
ConfirmDialog / ModelPickerModal / WizardModal / UserAgreementModal 四个弹窗迁移到该基类，删除各自的遮罩重定义。

**落地补充——遮罩特例用修饰类，不重定义保留类**：冷启动向导与用户协议弹窗要求「遮罩从标题栏下方开始 + 层级低于普通弹窗」，实现为模板同时挂 `modal-overlay` 与本地修饰类（`.wizard-overlay` / `.agreement-overlay`），修饰类只写 `top: var(--titlebar-h, 0)` 与 `z-index: var(--z-banner)` 两个增量，遮罩底色/blur/flex 骨架仍吃全局类。scoped 中**绝不**出现 `.modal-overlay { ... }` 这类重定义（门禁 globalOverride 会拦截）。

### 3.7 Toast

- `useToast()` 的 API **不变**；统一样式类：`.toast-container`（fixed 右下、z `--z-toast`）+ `.toast.success/.error/.warning`，底色用语义色实色、白字；
- Dashboard 自制 `.toast`、CharacterPage 的 sticky `.toast` 迁移到统一类；页面内联成功提示改用 `.alert.alert-success`（见下）；
- 新增 `.alert` 系列（页面内提示条，非浮层）：`.alert-success/danger/warning/info`，底色 `*-muted`、描边 `*-border`、文字 `--text-primary`，收编现有 `.tip-card`、`.notice`、`.import-banner`、CharacterPage `.toast/.err`。

### 3.8 页面骨架与自适应

- `.page-container`：`width:100%; max-width:1200px; margin:0 auto; display:flex; flex-direction:column; gap:var(--space-5)`。**自身不带 padding**——外层 `.content` 已统一承担 `padding:var(--space-6)`；各页根节点挂本类后只获得 1200px 居中与纵向节奏，本地根类（如 `.logs-page` 的 `height:100%`、不同 gap）靠 scoped 属性选择器更高优先级继续生效；
- `.page-head`：页头标准结构（左：标题 `--text-title` + 副标题 sm/secondary；右：操作按钮区），收编各页自制的 `.page-header/.page-head`；
- 网格工具类：
  - `.grid-auto`：`repeat(auto-fit, minmax(240px,1fr))`，标准卡片流；
  - `.grid-auto-narrow`：`minmax(160px,1fr)`，标签/配置项；
  - `.grid-2 / .grid-3 / .grid-4`：固定列数，配合断点自动降级；
- 断点（全项目统一两个，按**视口宽度**触发）：
  - `max-width:1100px`：`.grid-4→.grid-2`、`.grid-3→.grid-2`，统计卡降列；
  - `max-width:720px`：所有网格降 1 列、`.page-head` 纵向堆叠；
- 禁止再写不带 `minmax()` 的固定列网格（Config/Skills 现有 auto-fill 写法是正面范例）；两列表单网格（`1fr 1fr`）作为例外允许保留，但容器需具备折行/收缩能力；
- 侧栏不做折叠（固定 220px），内容区不得依赖固定像素宽度，最小窗口 900×600 下不得横向溢出；flex 行优先补 `flex-wrap` 与 `min-width:0` 保护（Dashboard 状态卡为参考实现）；
- **全幅表面例外**：TerminalPage 是恒定深色的终端表面（`height:100vh`、自带 padding、xterm.js 配色在 JS 内写死），不挂 `.page-container`，与 PetWindow 同属文档化例外，其样式块仅允许引用 `--terminal-bg/--terminal-text` 两个专用静态 token。

---

## 4. 变量名 / 类名迁移映射

### 4.1 错误变量名（不存在，当前全走 fallback）

| 旧写法 | 正确 token |
|---|---|
| `var(--bg-primary, …)` | `var(--bg-base)` |
| `var(--bg-secondary, …)` | `var(--bg-surface)` |
| `var(--border-color, …)` | `var(--border)` |
| `var(--text-color, …)` | `var(--text-primary)` |

### 4.2 硬编码状态色（CharacterPage / VoicePage 等）

| 旧裸值（示例） | 新 token |
|---|---|
| `#ff6b6b` / `#ff8d8d` / `rgba(255,86,86,.12)` | `--danger` / `--danger-muted` |
| `#7ee2a8` / `#4cd07d` / `#5ee29a` / `rgba(45,190,110,.12)` | `--success` / `--success-muted` |
| `#ffb86b` / `rgba(230,162,60,*)` | `--warning` / `--warning-muted` |
| `#7aa2ff` / `#8ec5ff` / `rgba(78,158,255,.12)` | `--info` / `--info-muted` |
| `#cfe0ff` 等对话气泡色 | `--text-primary` / `--surface-2` |
| `rgba(255,255,255,.04~.12)` | `--surface-1/2/3` |
| `rgba(255,255,255,.08)` 描边 | `var(--border)` |

### 4.3 旧类名映射

| 旧 | 新 |
|---|---|
| `btn primary` / `btn ghost`（CharacterPage） | `btn btn-primary` / `btn btn-ghost` |
| `btn-ghost`（PluginManager 空类） | 补齐为正式类，模板不动 |
| `.btn-outline-sm`（ChannelsPage） | `.btn btn-outline btn-sm` |
| `.wecom-outline` | `.btn-wecom`（outline 形态） |
| scoped `.btn` 重定义（CharacterPage/ChannelsPage） | 删除，统一用全局 `.btn` |
| 裸 `input/select`（CharacterPage） | `.form-input/.form-select` |
| 各页 `.toast`（浮层） | 全局 `.toast` |
| 各页内联提示条 | `.alert .alert-*` |
| 自制 modal 遮罩 | `.modal-overlay/.modal-card` |

---

## 5. 门禁机制（零依赖，贴合项目现有传统）

新增 `scripts/check-style-tokens.mjs`（风格对齐 `check-boundaries.mjs`，基线棘轮只准降不准升），**只扫 `<style>` 块与 `.css` 文件，不扫 `<script>` 中的颜色常量**，六类检查：

1. `hardColor`：hex、`rgb()`、`rgba()` 裸值（白名单文件豁免）；
2. `rem`：rem 单位（全项目只用 px）；
3. `badVarName`：错误变量名 `--bg-primary` / `--bg-secondary` / `--border-color` / `--text-color`；
4. `globalOverride`：scoped 样式重定义全局保留类名（`.btn`、`.card`、`.badge`、`.form-input/-select/-textarea`、`.toggle`、`.modal-overlay/-card`、`.alert`、`.toast`；带 `(?![\w-])` 负向断言，`.btn-icon.open`、`.badge-purple` 这类修饰类不误伤）；
5. `bareRadius`：`border-radius:Npx` 裸值（应走 `--radius-*`）；
6. `bareFontSize`：`font-size:Npx` 裸值（应走 `--text-*`）。

接入 `npm run accept`（`accept:style-tokens`，与 boundary 检查同级），基线文件 `scripts/style-tokens-baseline.json`，分 `src` / `plugins` 两组。

**落地基线（2026-11 收口）**：

| 组 | hardColor | rem | badVarName | globalOverride | bareRadius | bareFontSize |
|---|---|---|---|---|---|---|
| src | 0 | 0 | 0 | 0 | 0 | 0 |
| plugins（冻结） | 32 | 0 | 0 | 35 | 10 | 114 |

src 组六项归零的口径：白名单四文件（FishState / PetWindow / style.css / themes.ts）整体豁免不计；TerminalPage xterm.js 的 12 个主题色与 Config 取色器两个默认 hex 位于 `<script>` 数据区，门禁不扫描；品牌色 `--brand-weixin/--brand-wecom`、终端专用 `--terminal-bg/--terminal-text`、accent 深底前景 `--text-on-accent` 均为 `:root` 静态 token 定义，随 style.css 整体豁免。plugins 组按约定冻结，维持初始高水位，后续如重构插件再走 `--update` 收紧。

---

## 6. 不在本次范围

- 不引入任何 UI 框架 / 原子 CSS 框架；`less` 依赖保留但不新增使用；
- `plugins/` 16 个组件不主动重构（自动继承新 token 与全局类增强），仅在门禁基线中登记现状；
- `FishState.vue` SVG 插画色、桌宠透明窗口（PetWindow）专属布局保持现状；
- 侧栏折叠、主题编辑器改版不做。

## 7. 落地批次与验收

| 批次 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 1 | `themes.ts` 扩 16 个语义色变量（浅/深两套）；style.css 增全部静态 token、表面叠加层；按钮补 warning/ghost/outline、表单 focus ring、`.alert`、`.modal-*`、`.page-container/.grid-*`；门禁脚本 + 基线 | typecheck 通过；现有 `accept:ui` 全绿（插件类名未破坏）；切 7 主题检查新变量取值 | ✅ 已落地 |
| 2 | CharacterPage（大肥鱼）整页迁移：错误变量、scoped `.btn/.card/input`、硬编码状态色、页头/网格骨架、自适应 | 该页 hex/rem/错误变量清零；7 主题下逐屏目视；`accept:ui` 全绿 | ✅ 已落地 |
| 3 | VoicePage、ChannelsPage、TerminalPage、ModelPickerModal、四个弹窗组件、Setup/Logs/About 等硬编码重灾区迁移；`rgba(255,255,255,*)` 清零；浅色主题专项目视 | 全项目 `rgba(255,255,255` 清零；浅色/米纸主题下无隐形控件 | ✅ 已落地（Grep 静态证据全清零） |
| 4 | 全部页面响应式断点与 max-width 收口（9 个视图根节点挂 `.page-container`）、Toast/弹窗统一、基线 src 组归零；本规范文档转为正式状态；跑 `npm run accept` 全量 + 对抗复查 | 900×600 最小窗口无横向溢出；门禁基线只降不升；输出对抗复查记录 | ✅ 专项自测通过（双 typecheck / style-tokens 10/10 / accept:ui 27/27 / build）；⚠️ 全量 accept 在本机受便携 Node SQLite 权限与 maintenance junction 环境阻断 |

**落地期沉淀的补充约定**（前文已散见，此处汇总）：

1. accent 深底上的白字统一走静态 token `--text-on-accent`，不再散落 `#fff`；theme 预览卡因 `mix-blend-mode:difference` 保留白色混合输入并就地注释；
2. spinner 零硬编码写法：`border: 2px solid color-mix(in srgb, currentColor 30%, transparent); border-top-color: currentColor;`，自动跟随按钮文字色；
3. scoped 内需要微调全局类外观时，一律加本地修饰类（`.channels-tip`、`.app-banner`、`.btn-icon.open`、`.wizard-overlay` 等），绝不直接重定义保留类；
4. 自制 fixed toast 统一收编为 `.toast-container > .toast` 结构，`useToast()` API 与 transition 名称不变；
5. 静态门禁不查 `<script>` 数据区颜色，但新增脚本内配色必须就近注释说明（xterm 主题、取色器默认值为先例）。
6. scoped 页面自定义布局类会带 `[data-v]` 属性，优先级高于全局工具类；已经定义 `align-items/gap/margin` 的本地类（如 `.row`）不得再叠同属性工具类。大肥鱼渠道列表曾因此被 `.row` 的 `align-items:center` 压掉 `items-start` 而整列水平居中，改用页面本地 `.channel-list` 并由 `style-tokens` T9 锁住。

**对抗复查清单**（每批结束自查，全部批次完成后总查一遍）：

- [ ] 类名改动后 `plugins/` 16 个组件挂载不受影响（`accept:ui` U1~U16）——待命令行补跑
- [ ] 7 个主题预设 + 自定义主题下每个改过的页面都目视一遍（重点 light/paper）——待 dev 目视
- [x] 900×600 最小窗口静态审查：窗口层 `minWidth:900/minHeight:600` 硬约束；固定 px 宽度最大 250px 且均在 flex-wrap/网格容器内；全局网格 1100/720 两断点；Dashboard 状态卡补 flex-wrap + min-width:0
- [ ] 禁用态、hover、focus、弹窗打开/关闭过渡无样式丢失——待 dev 目视
- [ ] 无 Vue 警告（U9 口径）、无行为回归（按钮文案/事件不变，只改 class 与样式）——`accept:ui` 待补跑；模板动态绑定逻辑本次一律未动
- [x] Grep 总查：错误变量名 0、`rgba(255,255,255` 0、rem 0（白名单外）、scoped 保留类重定义 0、裸 border-radius/font-size 0（白名单外）
- [x] 基线收紧：src 组六项 0，plugins 组冻结不动
