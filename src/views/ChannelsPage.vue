<template>
  <div class="page channels-page">
    <div class="page-header">
      <h2>渠道接入</h2>
      <p class="page-sub">配置聊天平台，让 AI 助手接入你的消息渠道</p>
    </div>

    <div class="channels-list">
      <div
        v-for="ch in CHANNELS"
        :key="ch.key"
        :class="[
          'channel-card',
          expanded[ch.key] && 'expanded',
          isConfigured(ch.key) && 'configured',
        ]"
      >
        <div class="channel-header" @click="toggle(ch.key)">
          <span class="ch-icon">{{ ch.icon }}</span>
          <div class="ch-info">
            <span class="ch-label">{{ ch.label }}</span>
            <span class="ch-desc">{{ ch.desc }}</span>
          </div>
          <span v-if="isConfigured(ch.key)" class="ch-badge">已配置</span>
          <span class="ch-arrow">{{ expanded[ch.key] ? "▲" : "▼" }}</span>
        </div>

        <div v-if="expanded[ch.key]" class="channel-form">
          <div v-for="f in ch.fields" :key="f.id" class="form-group">
            <label v-if="f.type !== 'checkbox'">{{ f.label }}</label>
            <select
              v-if="f.type === 'select'"
              v-model="formValues[ch.key][f.id]"
              class="form-input"
            >
              <option v-for="opt in f.options" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
            <label v-else-if="f.type === 'checkbox'" class="form-check">
              <input v-model="formValues[ch.key][f.id]" type="checkbox" />
              <span>{{ f.label }}</span>
            </label>
            <input
              v-else
              v-model="formValues[ch.key][f.id]"
              type="text"
              :placeholder="f.placeholder"
              class="form-input"
            />
            <p v-if="f.hint" class="form-hint">
              {{ f.hint }}
              <button
                v-if="f.hintUrl"
                class="hint-link"
                @click="openExternalUrl(f.hintUrl)"
              >
                {{ f.hintLabel || "查看帮助" }}
              </button>
            </p>
          </div>
          <div class="docs-row">
            <button class="docs-btn" @click="openExternalUrl(ch.docsUrl)">
              📖 查看接入文档
            </button>
            <button
              v-if="ch.key === 'feishu'"
              class="docs-btn"
              @click="goToFeishuPairing"
            >
              🔗 前往终端配对审批
            </button>
          </div>
          <p v-if="ch.key === 'feishu'" class="form-hint">
            飞书采用长连接（WebSocket），无需公网回调。保存并重启后，陌生人首次私聊会生成配对码，
            在终端执行 <code>openclaw pairing list feishu</code> /
            <code>openclaw pairing approve feishu &lt;配对码&gt;</code> 审批即可。
          </p>
        </div>
      </div>
    </div>

    <div class="save-row">
      <button class="btn btn-primary" :disabled="saving" @click="save">
        <span v-if="saving" class="spinner"></span>
        {{ saving ? "正在保存配置..." : "💾 保存渠道配置" }}
      </button>
      <span v-if="savedMsg" class="save-msg">{{ savedMsg }}</span>
    </div>

    <div class="tip-card">
      <p>
        💻 其他渠道（QQ Bot、Telegram、Slack
        等）可在<strong>终端</strong>页面通过
        <code>openclaw channels setup</code> 命令添加。
      </p>
    </div>

    <div class="weixin-card">
      <div class="weixin-header">
        <span class="ch-icon">💚</span>
        <div class="ch-info">
          <span class="ch-label">微信（官方插件）</span>
          <span class="ch-desc"
            >插件已默认安装，扫码登录即可接入微信，无需 AppID/Secret</span
          >
        </div>
        <button
          class="docs-btn"
          @click="
            openExternalUrl(
              'https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin'
            )
          "
        >
          📖 文档
        </button>
      </div>
      <div class="weixin-steps">
        <div class="weixin-step">
          <span class="step-num">1</span>
          <div class="step-body">
            <div class="step-title">扫码登录</div>
            <div class="step-desc">
              切换到「终端」页面，执行登录命令，用手机扫码授权
            </div>
            <button class="btn btn-outline-sm" @click="goToWeixinLogin">
              📱 微信扫码登录
            </button>
          </div>
        </div>
        <div class="weixin-step">
          <span class="step-num">2</span>
          <div class="step-body">
            <div class="step-title">重启 OpenClaw</div>
            <div class="step-desc">登录成功后重启服务，微信渠道即可上线</div>
          </div>
        </div>
      </div>
      <div v-if="weixinMsg" class="weixin-msg">{{ weixinMsg }}</div>
    </div>

    <div class="weixin-card wecom-card">
      <div class="weixin-header">
        <span class="ch-icon">💼</span>
        <div class="ch-info">
          <span class="ch-label">企业微信（官方插件）</span>
          <span class="ch-desc"
            >运行官方安装向导：安装插件、扫码接入、一键创建机器人，无需 CorpID/Secret</span
          >
        </div>
        <button
          class="docs-btn"
          @click="
            openExternalUrl('https://www.npmjs.com/package/@wecom/wecom-openclaw-cli')
          "
        >
          📖 文档
        </button>
      </div>
      <div class="weixin-steps">
        <div class="weixin-step">
          <span class="step-num">1</span>
          <div class="step-body">
            <div class="step-title">安装插件并扫码</div>
            <div class="step-desc">
              切换到「终端」页面运行官方安装向导，按提示用企业微信扫码接入、一键创建机器人
            </div>
            <button class="btn btn-outline-sm wecom-outline" @click="goToWecomLogin">
              💼 企微扫码接入
            </button>
          </div>
        </div>
        <div class="weixin-step">
          <span class="step-num">2</span>
          <div class="step-body">
            <div class="step-title">重启 OpenClaw</div>
            <div class="step-desc">
              机器人创建成功后重启服务，企业微信渠道即可上线，前往企业微信开始对话
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router"; // 👈 引入 Vue 路由，摆脱 props

const router = useRouter();
const weixinMsg = ref("");

// ── 1. 外部链接调用解耦 ──────────────────────────────────────────────────
function openExternalUrl(url: string) {
  if (window.api?.shell?.openExternal) {
    window.api.shell.openExternal(url);
  } else {
    window.open(url, "_blank");
  }
}

// ── 2. 路由无缝跳切微信登录 ───────────────────────────────────────────────
function goToWeixinLogin() {
  // 直接通过内置路由对象，带着暗号跳转到终端控制台页面
  router.push({
    path: "/terminal", // 👈 如果你的终端控制台路由叫 /console，请改成 /console
    query: { autoRun: "channels login --channel openclaw-weixin" },
  });
}

// ── 2.1 路由跳切企微官方安装向导 ──────────────────────────────────────────
// 企微接入走 @wecom/wecom-openclaw-cli（npm 包 CLI，非 openclaw 子命令），
// 终端页识别 autoRun 的 npx 前缀后会以交互式 PTY 拉起向导：
// 安装插件 -> 扫码接入 -> 一键创建机器人 -> 自动接入本地 OpenClaw
function goToWecomLogin() {
  router.push({
    path: "/terminal",
    query: { autoRun: "npx -y @wecom/wecom-openclaw-cli install" },
  });
}

// 飞书配对审批：跳转终端并预填 pairing 列表命令
function goToFeishuPairing() {
  router.push({
    path: "/terminal",
    query: { autoRun: "pairing list feishu" },
  });
}

// ── 3. 核心多渠道 Schema 配置（保持不变） ───────────────────────────────────
type ChannelKey = "feishu" | "wechat_mp" | "wecom" | "dingtalk";

interface ChannelConfig {
  key: ChannelKey;
  icon: string;
  label: string;
  desc: string;
  docsUrl: string;
  fields: {
    id: string;
    label: string;
    type?: "text" | "select" | "checkbox";
    placeholder?: string;
    options?: { label: string; value: string }[];
    default?: string | boolean;
    optional?: boolean;
    hint?: string;
    hintUrl?: string;
    hintLabel?: string;
  }[];
}

const CHANNELS: ChannelConfig[] = [
  {
    key: "feishu",
    icon: "💙",
    label: "飞书自建应用",
    desc: "通过飞书开放平台机器人，将 AI 接入企业飞书群聊或单聊",
    docsUrl: "https://open.feishu.cn/document/home/index",
    fields: [
      {
        id: "appId",
        label: "App ID",
        placeholder: "cli_xxxxxxxxxxxxxxxx",
        hint: "在飞书开放平台「凭证与基础信息」中获取",
      },
      {
        id: "appSecret",
        label: "App Secret",
        placeholder: "输入你的飞书 App Secret",
        hint: "切勿公开此凭证",
      },
      {
        id: "encryptKey",
        label: "Encrypt Key (选填)",
        optional: true,
        placeholder: "飞书事件订阅的加密密钥",
        hint: "长连接模式无需填写；仅 Webhook 模式需要",
      },
      {
        id: "verificationToken",
        label: "Verification Token (选填)",
        optional: true,
        placeholder: "飞书事件订阅的验证 Token",
        hint: "长连接模式无需填写；仅 Webhook 模式需要",
      },
      {
        id: "dmPolicy",
        label: "私聊策略",
        type: "select",
        default: "pairing",
        options: [
          { label: "配对审批（陌生人先配对）", value: "pairing" },
          { label: "允许所有人", value: "open" },
          { label: "仅白名单", value: "allowlist" },
        ],
        hint: "陌生人首次私聊的处理方式，默认需要配对审批",
      },
      {
        id: "groupPolicy",
        label: "群聊策略",
        type: "select",
        default: "allowlist",
        options: [
          { label: "仅白名单群", value: "allowlist" },
          { label: "允许所有群", value: "open" },
        ],
      },
      {
        id: "requireMention",
        label: "群聊中需要 @机器人 才响应",
        type: "checkbox",
        default: true,
      },
    ],
  },
  {
    key: "wechat_mp",
    icon: "💬",
    label: "微信公众号",
    desc: "接入微信粉丝个人或订阅号/服务号后台，实现私信自动回复",
    docsUrl:
      "https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html",
    fields: [
      {
        id: "appId",
        label: "开发者ID (AppID)",
        placeholder: "wxxxxxxxxxxxxxxxx",
      },
      {
        id: "appSecret",
        label: "开发者密码 (AppSecret)",
        placeholder: "输入你的公众号 AppSecret",
      },
      {
        id: "token",
        label: "令牌 (Token)",
        placeholder: "自定义或公众号后台设置的 Token",
        hint: "用于服务器配置的基本安全校验",
      },
    ],
  },
  {
    key: "wecom",
    icon: "🏢",
    label: "企业微信应用",
    desc: "通过企微自建应用或应用型机器人，接入企业内部通讯",
    docsUrl: "https://developer.work.weixin.qq.com/",
    fields: [
      {
        id: "corpId",
        label: "企业 ID (CorpID)",
        placeholder: "wwxxxxxxxxxxxxxx",
      },
      {
        id: "agentId",
        label: "应用 AgentID",
        placeholder: "100000x",
      },
      {
        id: "secret",
        label: "应用 Secret",
        placeholder: "输入企业微信应用 Secret",
      },
    ],
  },
  {
    key: "dingtalk",
    icon: "🔹",
    label: "钉钉机器人",
    desc: "接入钉钉群聊企业内部自建或单聊机器人",
    docsUrl: "https://open.dingtalk.com/",
    fields: [
      {
        id: "appKey",
        label: "AppKey",
        placeholder: "dingxxxxxxxxxxxxxx",
      },
      {
        id: "appSecret",
        label: "AppSecret",
        placeholder: "输入钉钉 AppSecret",
      },
    ],
  },
];

const formValues = ref<Record<string, Record<string, string | boolean>>>({});
const expanded = ref<Record<string, boolean>>({});
const saving = ref(false);
const savedMsg = ref("");

// ── 4. 生命周期与配置初始化 ──────────────────────────────────────────────────
onMounted(async () => {
  // 1. 初始化表单内存空间
  for (const ch of CHANNELS) {
    formValues.value[ch.key] = {};
    for (const f of ch.fields) {
      formValues.value[ch.key][f.id] =
        f.default !== undefined ? f.default : f.type === "checkbox" ? false : "";
    }
    expanded.value[ch.key] = false;
  }

  // 2. 直接从 window.api 异步加载后端配置，解决原有 props.onGetChannels 报错
  try {
    if (window.api?.config?.get) {
      const config = await window.api.config.get();
      const existing = config?.channels || {};

      for (const ch of CHANNELS) {
        const cfg = existing[ch.key] as Record<string, unknown> | undefined;
        if (cfg) {
          expanded.value[ch.key] = true; // 有旧配置的默认展开
          for (const f of ch.fields) {
            if (cfg[f.id] !== undefined) {
              formValues.value[ch.key][f.id] =
                f.type === "checkbox"
                  ? Boolean(cfg[f.id])
                  : (cfg[f.id] as string);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("加载渠道已有配置失败:", err);
  }
});

// ── 5. 交互行为逻辑 ───────────────────────────────────────────────────
function toggle(key: ChannelKey) {
  expanded.value[key] = !expanded.value[key];
}

function isRequiredText(f: ChannelConfig["fields"][number]): boolean {
  return (!f.type || f.type === "text") && !f.optional;
}

function isConfigured(key: ChannelKey): boolean {
  const ch = CHANNELS.find((c) => c.key === key);
  if (!ch) return false;
  return ch.fields
    .filter(isRequiredText)
    .every((f) => !!String(formValues.value[key]?.[f.id] ?? "").trim());
}

async function save() {
  saving.value = true;
  savedMsg.value = "";
  try {
    const channelConfigs: Record<string, unknown> = {};

    for (const ch of CHANNELS) {
      // 只有被展开或者正在填写的渠道才同步到配置文件中
      if (!expanded.value[ch.key]) continue;

      const vals = formValues.value[ch.key];
      const allFilled = ch.fields
        .filter(isRequiredText)
        .every((f) => !!String(vals[f.id] ?? "").trim());

      if (allFilled) {
        const entry: Record<string, unknown> = { enabled: true };
        for (const f of ch.fields) {
          const v = vals[f.id];
          if (f.type === "checkbox") {
            entry[f.id] = Boolean(v);
          } else {
            const s = String(v ?? "").trim();
            if (s === "" && f.optional) continue;
            entry[f.id] = s;
          }
        }
        channelConfigs[ch.key] = entry;
      }
    }

    // 闭环处理保存：先获取完整配置，避免抹除 models/gateway 等其他配置项
    if (window.api?.config?.get && window.api?.config?.save) {
      const fullConfig = (await window.api.config.get()) || {};
      fullConfig.channels = channelConfigs;

      await window.api.config.save(fullConfig);
      savedMsg.value = "✅ 已保存，重启 OpenClaw 后生效";

      // 飞书为插件驱动渠道：已配置且插件未安装时，自动安装官方插件
      const feishuConfigured = !!channelConfigs["feishu"];
      if (feishuConfigured && window.api?.channels?.installPlugin) {
        try {
          const installed =
            (await window.api.channels.isPluginInstalled?.("feishu")) ?? false;
          if (!installed) {
            savedMsg.value = "⏳ 正在安装飞书插件（首次约 1-2 分钟）...";
            const res = await window.api.channels.installPlugin(
              "@openclaw/feishu"
            );
            if (res?.success) {
              savedMsg.value = "✅ 飞书插件已安装，请重启 OpenClaw 生效";
            } else {
              savedMsg.value = `⚠️ 配置已保存，但插件安装失败：${res?.error || "未知错误"}`;
            }
          }
        } catch (e) {
          savedMsg.value = `⚠️ 配置已保存，但插件安装失败：${e}`;
        }
      }
    } else {
      throw new Error("主进程安全沙箱配置保存 API 不可用");
    }
  } catch (e) {
    savedMsg.value = `❌ 保存失败: ${e}`;
  } finally {
    saving.value = false;
    setTimeout(() => {
      savedMsg.value = "";
    }, 4000);
  }
}
</script>

<style lang="less" scoped>
.channels-page {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.page-header {
  margin-bottom: 20px;
}
.page-header h2 {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 2px;
}
.page-sub {
  font-size: 0.8rem;
  color: var(--text-secondary);
}
.channels-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 20px;
}
.channel-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-surface);
  overflow: hidden;
  transition: border-color 0.15s;
}
.channel-card.configured {
  border-color: var(--green);
}
.channel-card.expanded {
  border-color: var(--accent);
}
.channel-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  user-select: none;
}
.channel-header:hover {
  background: var(--bg-elevated);
}
.ch-icon {
  font-size: 1.3rem;
  flex-shrink: 0;
}
.ch-info {
  flex: 1;
  min-width: 0;
}
.ch-label {
  display: block;
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--text-primary);
}
.ch-desc {
  display: block;
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 1px;
}
.ch-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--green) 15%, transparent);
  color: var(--green);
  flex-shrink: 0;
}
.ch-arrow {
  font-size: 0.7rem;
  color: var(--text-muted);
  flex-shrink: 0;
}
.channel-form {
  padding: 0 16px 16px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 14px;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.form-group label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 500;
}
.form-input {
  padding: 9px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-primary);
  font-size: 0.85rem;
  outline: none;
  transition: border-color 0.15s;
}
.form-input:focus {
  border-color: var(--accent);
}
.form-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--text-primary);
  cursor: pointer;
}
.form-check input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}
.form-hint {
  font-size: 0.75rem;
  color: var(--text-secondary);
}
.hint-link {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: inherit;
  padding: 0;
  text-decoration: underline;
}
.hint-link:hover {
  color: var(--accent-hover);
}
.docs-row {
  display: flex;
  justify-content: flex-end;
}
.docs-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 12px;
  color: var(--text-secondary);
  font-size: 0.78rem;
  cursor: pointer;
  transition: all 0.15s;
}
.docs-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border-color: var(--accent);
}
.save-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding: 0 4px;
}
.save-msg {
  font-size: 0.82rem;
  color: var(--text-primary);
  font-weight: 500;
}
.btn {
  padding: 9px 20px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s;
}
.btn-primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}
.btn-primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  display: inline-block;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.tip-card {
  background: color-mix(in srgb, var(--blue) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--blue) 25%, transparent);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 0.8rem;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 16px;
}
.tip-card strong {
  color: var(--text-primary);
}
.tip-card code {
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.85em;
  color: var(--accent);
  font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
}
.weixin-card {
  border: 1px solid color-mix(in srgb, #10b981 40%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, #10b981 5%, var(--bg-surface));
  padding: 16px;
  margin-top: 4px;
}
/* 企微品牌蓝卡片 */
.wecom-card {
  border-color: color-mix(in srgb, #0082f0 40%, transparent);
  background: color-mix(in srgb, #0082f0 5%, var(--bg-surface));
}
.wecom-outline {
  border-color: #0082f0;
  color: #0082f0;
}
.wecom-outline:hover:not(:disabled) {
  background: color-mix(in srgb, #0082f0 10%, transparent);
}
.weixin-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.weixin-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.weixin-step {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.step-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}
.step-body {
  flex: 1;
}
.step-title {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}
.step-desc {
  font-size: 0.78rem;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.step-desc code {
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.85em;
  color: var(--accent);
}
.btn-outline-sm {
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--accent);
  color: var(--accent);
  background: transparent;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: all 0.15s;
}
.btn-outline-sm:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.btn-outline-sm:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.weixin-msg {
  margin-top: 12px;
  font-size: 0.82rem;
  color: var(--text-secondary);
  padding: 8px 12px;
  background: var(--bg-elevated);
  border-radius: 6px;
}
</style>