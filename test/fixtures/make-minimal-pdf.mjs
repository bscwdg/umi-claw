// test/fixtures/make-minimal-pdf.mjs —— 生成「最小 PDF」样本（无外部依赖，手写 PDF 结构）
//
// 用途：Commit 05a 验收需要一个**可提交、体积忽略不计**的 PDF：
//   - `withText: true`  → 有文字层（ASCII + 数字），用于断言「文字层抽取 + 数字有序」
//   - `withText: false` → 无文字层（页面只有一块填充矩形），用于断言「扫描件检测 → FILE_PARSE_ERROR」
// 中文文字层无法靠手写 PDF 造出来（需要嵌入 CJK 字体），因此中文样例走环境变量
// `KNW_PDF_SAMPLE` 指向的**真实**中文 PDF（见 test/knowledge.accept.mjs 的 K7）。
//
// 重新生成已提交的样本：
//   node test/fixtures/make-minimal-pdf.mjs            # 打印 base64，或写入 test/fixtures/min-text-layer.pdf

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 默认文字层内容（每行一个 Tj，行间用 T* 换行） */
export const SAMPLE_PDF_LINES = [
  'UMI CLAW KNOWLEDGE PDF FIXTURE',
  'SUITE A 128 CNY',
  'SUITE B 256 CNY',
  'SUITE C 512 CNY',
  'TOTAL 1024 CNY'
]

/**
 * 手写一份最小 PDF（单页 A4）。
 * @param {{ lines?: string[], withText?: boolean }} [options]
 * @returns {Buffer}
 */
export function buildMinimalPdf(options = {}) {
  const lines = options.lines ?? SAMPLE_PDF_LINES
  const withText = options.withText !== false
  const content = withText
    ? 'BT /F1 14 Tf 72 720 Td 18 TL\n' + lines.map((l) => `(${escapePdfString(l)}) Tj T*`).join('\n') + '\nET'
    : '0 0 1 rg 72 700 200 100 re f'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n'
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function escapePdfString(text) {
  return String(text).replace(/[\\()]/g, (m) => '\\' + m)
}

/** 已提交的文字层样本路径 */
export const MIN_TEXT_LAYER_PDF = join(here, 'min-text-layer.pdf')

// CLI：写入已提交的样本文件
if (process.argv[1] && process.argv[1].endsWith('make-minimal-pdf.mjs')) {
  writeFileSync(MIN_TEXT_LAYER_PDF, buildMinimalPdf())
  console.log(`已生成 ${MIN_TEXT_LAYER_PDF}（${buildMinimalPdf().length} bytes）`)
}
