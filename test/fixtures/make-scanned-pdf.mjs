// test/fixtures/make-scanned-pdf.mjs —— 生成「最小扫描件 PDF」样本（Commit 05b 验收 fixture）
//
// 用途：05b 的可行性探针与验收需要一个**可提交、体积小、无文字层**的扫描 PDF：
//   每页只嵌一张 DCTDecode（JPEG）图像 XObject，三页尺寸各不相同（320x200 / 320x180 / 320x160），
//   便于断言「逐页取图 → 页序与尺寸都正确」。页面上画了「类文字」的色块行（不同页颜色不同），
//   探针可把解出的 PNG 像素与 sharp 原图逐字节比对，验证位图提取无失真。
//
// 重新生成：node test/fixtures/make-scanned-pdf.mjs
//   （需要 devDependency `sharp` 在场；产物已提交入库，验收脚本本身不依赖 sharp ——
//     仅「重新生成 fixture」这一步用得到。）
//
// 手写 PDF 结构的口径与 make-minimal-pdf.mjs 一致（xref 偏移 = 字节偏移，
// 图像流为二进制，必须 Buffer concat，不能走 latin1 字符串拼接）。

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 三页扫描件（尺寸互不相同 → 页序/页号可断言） */
export const SCANNED_PAGES = [
  { width: 320, height: 200, seed: 'A' },
  { width: 320, height: 180, seed: 'B' },
  { width: 320, height: 160, seed: 'C' }
]

/**
 * 用 sharp 造一页「模拟扫描文字」的 JPEG：
 * 浅灰底 + 每页专属底纹色 + 若干深色横条（类文字行）+ 一条高亮色「价格数字」带。
 * 输出 sRGB JPEG（DCTDecode），像素数据确定可复现。
 */
export async function buildPageJpeg(width, height, seed) {
  const { default: sharp } = await import('sharp')
  const tint = seed === 'A' ? [214, 222, 234] : seed === 'B' ? [234, 222, 214] : [214, 234, 222]
  // 原始 RGBA→RGB：底色带轻微纵向渐变（模拟扫描噪声），叠深色文字行
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 3
      const grad = ((x * 7 + y * 3) % 11) - 5 // -5..5 抖动
      raw[off] = clamp8(tint[0] + grad)
      raw[off + 1] = clamp8(tint[1] + grad)
      raw[off + 2] = clamp8(tint[2] + grad)
    }
  }
  const draw = (x0, y0, w, h, [r, g, b]) => {
    for (let y = y0; y < Math.min(height, y0 + h); y++) {
      for (let x = x0; x < Math.min(width, x0 + w); x++) {
        const off = (y * width + x) * 3
        raw[off] = r
        raw[off + 1] = g
        raw[off + 2] = b
      }
    }
  }
  // 「文字行」：每页 6 行深色条，长度按 seed 变化（保证三页像素互异）
  const seedN = seed.charCodeAt(0)
  for (let line = 0; line < 6; line++) {
    const lw = 40 + ((seedN * 13 + line * 29) % 180)
    draw(20, 20 + line * 22, lw, 10, [40, 40, 46])
  }
  // 「价格带」：高亮红条（OCR 场景里的价格行占位）
  draw(20, height - 30, width - 60, 16, [196, 42, 42])
  const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer()
  return jpeg
}

function clamp8(n) {
  return Math.max(0, Math.min(255, n | 0))
}

/**
 * 手写一份「纯图像页」PDF（无文字层，每页一张 DCTDecode JPEG）。
 * @param {Array<{jpeg: Buffer, width: number, height: number}>} pages
 */
export function buildScannedPdf(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('buildScannedPdf 需要至少一页')
  // 对象号：1=Catalog 2=Pages；第 i 页(0基)：page=3+3i, content=4+3i, image=5+3i
  const objects = new Map() // num -> Buffer
  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')
  objects.set(1, buf(`<< /Type /Catalog /Pages 2 0 R >>`))
  objects.set(2, buf(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`))
  pages.forEach((p, i) => {
    const pageNo = 3 + 3 * i
    const contentNo = pageNo + 1
    const imageNo = pageNo + 2
    objects.set(
      pageNo,
      buf(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] ` +
          `/Resources << /XObject << /Im0 ${imageNo} 0 R >> >> /Contents ${contentNo} 0 R >>`
      )
    )
    const content = `q ${p.width} 0 0 ${p.height} 0 0 cm /Im0 Do Q`
    objects.set(contentNo, buf(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
    const header = buf(
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`
    )
    objects.set(imageNo, Buffer.concat([header, p.jpeg, buf('\nendstream')]))
  })

  const nums = [...objects.keys()].sort((a, b) => a - b)
  const chunks = [buf('%PDF-1.4\n')]
  const offsets = []
  let pos = chunks[0].length
  nums.forEach((n) => {
    offsets[n] = pos
    const body = Buffer.concat([buf(`${n} 0 obj\n`), objects.get(n), buf('\nendobj\n')])
    chunks.push(body)
    pos += body.length
  })
  const xrefPos = pos
  let xref = `xref\n0 ${nums.length + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= nums.length; n++) xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n'
  xref += `trailer\n<< /Size ${nums.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  chunks.push(buf(xref))
  return Buffer.concat(chunks)
}

function buf(s) {
  return Buffer.from(s, 'latin1')
}

/** 对象表 → PDF Buffer（xref 偏移=字节偏移；对象号从 1 起连排） */
function assemblePdfObjects(objects) {
  const nums = [...objects.keys()].sort((a, b) => a - b)
  const chunks = [buf('%PDF-1.4\n')]
  const offsets = []
  let pos = chunks[0].length
  nums.forEach((n) => {
    offsets[n] = pos
    const body = Buffer.concat([buf(`${n} 0 obj\n`), objects.get(n), buf('\nendobj\n')])
    chunks.push(body)
    pos += body.length
  })
  const xrefPos = pos
  let xref = `xref\n0 ${nums.length + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= nums.length; n++) xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n'
  xref += `trailer\n<< /Size ${nums.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  chunks.push(buf(xref))
  return Buffer.concat(chunks)
}

/**
 * 每页多图的扫描件 PDF（同页 N 张 XObject）——05b S17 验「一页多图」语义。
 * @param {Array<{ width:number, height:number, images: Array<{ jpeg: Buffer, width:number, height:number }> }>} pages
 */
export function buildScannedPdfMulti(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('buildScannedPdfMulti 需要至少一页')
  const objects = new Map()
  const pageCount = pages.length
  const pageObjOf = pages.map((_, i) => 3 + 2 * i)
  let imageCursor = 3 + 2 * pageCount
  const imageObjOf = pages.map((p) => p.images.map(() => imageCursor++))
  const kids = pageObjOf.map((n) => `${n} 0 R`).join(' ')
  objects.set(1, buf(`<< /Type /Catalog /Pages 2 0 R >>`))
  objects.set(2, buf(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`))
  pages.forEach((p, i) => {
    const pageNo = pageObjOf[i]
    const imageNo = imageObjOf[i]
    const xobjs = p.images.map((_, j) => `/Im${j} ${imageNo[j]} 0 R`).join(' ')
    objects.set(
      pageNo,
      buf(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] ` +
          `/Resources << /XObject << ${xobjs} >> >> /Contents ${pageNo + 1} 0 R >>`
      )
    )
    // 每张图各自 /Im0../ImN 平铺整页（视觉重叠无所谓——识别器按「算子出现顺序」逐张取）
    const content = p.images.map((_, j) => `q ${p.width} 0 0 ${p.height} 0 0 cm /Im${j} Do Q`).join('\n')
    objects.set(pageNo + 1, buf(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
    p.images.forEach((img, j) => {
      const header = buf(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`
      )
      objects.set(imageNo[j], Buffer.concat([header, img.jpeg, buf('\nendstream')]))
    })
  })
  return assemblePdfObjects(objects)
}

/**
 * 只含**内嵌图**（BI/ID/EI，1BPP 灰度，/F /AHx 十六进制）的一页 PDF——
 * 05b S17 验内嵌图扫描件。⚙️ 实测事实（写探针时探出）：pdfjs **v3 不发 OPS 86**，而是把内嵌图
 * 转成 `paintImageXObject` + 合成 objId（`img_p0_1`）放进 `page.objs`（commonObjs 里没有）；
 * OPS 86/87 分支作为防御保留（部分路径真会直发 86，见 worker 的 addImageOps）。
 * 另：AHx 的 `>` 是 **EOD 结束符**（ISO 32000-1 §7.4.4.1）：出现即终止解码（在数据中间表现为截断），
 * 故行分隔只用空白，hex 流里不得出现 '>'。
 */
export function buildInlineImagePdf(width, height) {
  const rowBytes = Math.ceil(width / 8)
  let hex = ''
  for (let y = 0; y < height; y++) {
    let row = ''
    for (let b = 0; b < rowBytes; b++) {
      // 交替条带：行号 %4<2 → 全黑行，否则隔列黑——保证解码后非纯色，像素可断言
      const byte = y % 4 < 2 ? 0xff : b === 0 ? 0xf0 : 0x00
      row += byte.toString(16).padStart(2, '0')
    }
    hex += row + '\n' // 行分隔只用空白；**不得**出现 '>'（EOD 结束符，出现即终止解码）
  }
  const content =
    `q ${width} 0 0 ${height} 0 0 cm\n` +
    `BI /W ${width} /H ${height} /BPC 1 /CS /G /F /AHx ID\n${hex}EI Q`
  const objects = new Map()
  objects.set(1, buf(`<< /Type /Catalog /Pages 2 0 R >>`))
  objects.set(2, buf(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`))
  objects.set(3, buf(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents 4 0 R >>`))
  objects.set(4, buf(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
  return assemblePdfObjects(objects)
}

/** 已提交的扫描件样本路径 */
export const MIN_SCANNED_PDF = join(here, 'min-scanned.pdf')

/** 生成 fixture 的 PDF buffer（三页，页尺寸见 SCANNED_PAGES；与已提交样本字节一致） */
export async function generateScannedPdfBuffer() {
  const pages = []
  for (const p of SCANNED_PAGES) {
    pages.push({ jpeg: await buildPageJpeg(p.width, p.height, p.seed), width: p.width, height: p.height })
  }
  return buildScannedPdf(pages)
}

// CLI：写入已提交的样本文件
if (process.argv[1] && process.argv[1].endsWith('make-scanned-pdf.mjs')) {
  const pdf = await generateScannedPdfBuffer()
  writeFileSync(MIN_SCANNED_PDF, pdf)
  console.log(`已生成 ${MIN_SCANNED_PDF}（${pdf.length} bytes，${SCANNED_PAGES.length} 页纯图像）`)
}
