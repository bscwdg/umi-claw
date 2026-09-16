/**
 * 摄影行业首套预设（Commit 04）
 *
 * 只做「点一下就能填」的快捷筹码，**不替老板做决定**：填进去的还是可编辑的文本。
 * 关注词预设 ≤ WATCHLIST_MAX（10），避免一键补齐直接撞上限。
 */

export const PHOTOGRAPHY_INDUSTRY = '摄影'

/** 商家定位候选（业务定位，不是营销口号） */
export const BUSINESS_POSITIONING_PRESETS = [
  '婚纱摄影',
  '个人写真',
  '亲子儿童摄影',
  '证件照 / 形象照',
  '商业产品摄影',
  '旅拍跟拍'
]

/** 目标客群候选 */
export const BUSINESS_TARGET_CUSTOMER_PRESETS = [
  '备婚新人',
  '年轻女性',
  '宝妈亲子家庭',
  '职场人士',
  '中小企业主',
  '在校学生'
]

/** 沟通语气候选（影响 AI 写文案的口吻） */
export const BUSINESS_TONE_PRESETS = [
  '温暖亲切',
  '专业高端',
  '活泼有趣',
  '简洁克制',
  '文艺清新'
]

/** 关注词「行业预设词」——摄影店常用关注点，一键补齐 */
export const WATCHLIST_INDUSTRY_PRESETS = [
  '婚纱摄影',
  '写真',
  '亲子照',
  '证件照',
  '旅拍',
  '毕业照',
  '孕妇照',
  '全家福',
  '产品摄影',
  '修图'
]

/** 字段中文标签（与 businesses 表字段一一对应） */
export const BUSINESS_FIELD_LABELS: Record<string, string> = {
  name: '商家名称',
  brand: '品牌名',
  city: '城市',
  address: '门店地址',
  phone: '联系电话',
  positioning: '业务定位',
  target_customer: '目标客群',
  tone: '沟通语气'
}

/** 关注词分类标签（type 列） */
export const WATCHLIST_TYPE_LABELS: Record<string, string> = {
  industry: '行业',
  product: '产品',
  audience: '人群',
  region: '地域'
}
