// test/scan.probe.mjs —— Commit 05b 可行性探针：纯 Node 把扫描 PDF 页转 PNG data URI
//
// 配方（05b 第一步，结果决定实现范围）：
//   仓库自带 `resources/pdfjs/build/pdf.js`（v3 legacy 构建，createRequire 按路径加载，
//   与 documentParsers.loadPdfjsModule 同一份文件）→ 对每页 `getOperatorList()` →
//   遇到 OPS.paintImageXObject 时从 `page.objs` 取解码后位图（imgData：kind 1/2/3 = 1bit灰/RGB/RGBA）
//   → node:zlib 手写 PNG 编码（IHDR/IDAT/IEND + CRC32）→ data URI。
//
// 判据：
//   P1 真扫描 fixture（min-scanned.pdf，3 页纯图像）逐页取出 1 张图、页序与尺寸正确；
//   P2 手写 PNG 编码可被 sharp 解码，且解码像素与 pdfjs 位图**逐字节一致**（编码器无损往返）；
//   P3 data URI 形态通过 07 的 imageDataPart() 校验；
//   P4 文字层 PDF（min-text-layer.pdf）抽出 0 张图 → 「无图 ⇒ 不是扫描件」的反向判据成立。
//
//   判据与用法不变；证据回写仓库跟踪文件 `test/probe-scan-render.json`（S13 每次复跑重生成，时间戳 churn 属预期）。
//
// 用法：node test/scan.probe.mjs   （探针失败 → 05b 一期降级为「只收图片文件」）

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { bundleEntry, tmpDir } from './_lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

const results = { ok: false, checks: [], startedAt: new Date().toISOString() }

function check(id, name, fn) {
  return (async () => {
    try {
      const detail = await fn()
      results.checks.push({ id, name, ok: true, detail: String(detail ?? '') })
      console.log(`[PASS] ${id} ${name} -> ${detail ?? ''}`)
    } catch (e) {
      results.checks.push({ id, name, ok: false, detail: (e && e.stack) || String(e) })
      console.log(`[FAIL] ${id} ${name}`)
      console.log(String((e && e.stack) || e).split('\n').map((l) => '        ' + l).join('\n'))
    }
  })()
}

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg)
}
function assertEqSafe(actual, expected, msg) {
  if (actual !== expected) throw new Error(`断言失败: ${msg} — 期望 ${expected}，实际 ${actual}`)
}

// ── PNG 编码（纯 Node：node:zlib + 自实现 CRC32） ─────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * RGBA 位图 → PNG（color type 6，filter 0，逐行加前缀字节）。
 * @param {{ width: number, height: number, rgba: Uint8Array }} bitmap
 */
export function encodePng({ width, height, rgba }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng 非法尺寸: ${width}x${height}`)
  }
  const expected = width * height * 4
  if (rgba.length < expected) throw new Error(`encodePng 数据不足: ${rgba.length} < ${expected}`)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter none
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x]
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** pdfjs imgData（三种 kind）→ RGBA 位图 */
export function imgDataToRgba(img) {
  const { width, height, kind, data } = img
  if (!width || !height || !data) throw new Error(`imgData 缺字段: w=${width} h=${height} data=${!!data}`)
  const src = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (kind === 3) {
    // RGBA_32BPP
    return { width, height, rgba: src }
  }
  if (kind === 2) {
    // RGB_24BPP → 补 A=255
    assert(src.length >= width * height * 3, `RGB_24BPP 长度不足 ${src.length}`)
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = src[i * 3]
      rgba[i * 4 + 1] = src[i * 3 + 1]
      rgba[i * 4 + 2] = src[i * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
    return { width, height, rgba }
  }
  if (kind === 1) {
    // GRAYSCALE_1BPP：按位展开（pdfjs 语义：位=0 → 黑，1 → 白；行按字节对齐）
    const rgba = new Uint8Array(width * height * 4)
    const rowBytes = Math.ceil(width / 8)
    assert(src.length >= rowBytes * height, `1BPP 长度不足 ${src.length}`)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const v = bit ? 255 : 0
        const i = (y * width + x) * 4
        rgba[i] = v
        rgba[i + 1] = v
        rgba[i + 2] = v
        rgba[i + 3] = 255
      }
    }
    return { width, height, rgba }
  }
  throw new Error(`未知 imgData.kind: ${kind}`)
}

// ── 从一页操作流里抽出图像对象（与 scanRecognizer.extractPageImages 同构的探针版） ──

export async function extractImagesFromPage(pdfjs, page) {
  const ops = await page.getOperatorList()
  const found = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintImageXObjectRepeat) {
      const objId = ops.argsArray[i][0]
      // getOperatorList 完成时图像对象已随消息到达 objs 缓存；get 可能回 Promise（异步补齐）
      const img = await page.objs.get(objId)
      if (img) found.push({ objId, imgData: img })
    }
  }
  return found
}

async function openDoc(pdfjs, filePath) {
  const assetsRoot = join(repoRoot, 'resources', 'pdfjs')
  pdfjs.GlobalWorkerOptions.workerSrc = join(assetsRoot, 'build', 'pdf.worker.js')
  return pdfjs.getDocument({
    data: new Uint8Array(readFileSync(filePath)),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    cMapUrl: assetsRoot + (process.platform === 'win32' ? '\\cmaps\\' : '/cmaps/'),
    cMapPacked: true
  }).promise
}

async function main() {
  const requireFrom = createRequire(join(here, 'noop.cjs'))
  const pdfjs = requireFrom(join(repoRoot, 'resources', 'pdfjs', 'build', 'pdf.js'))
  const scannedPath = join(here, 'fixtures', 'min-scanned.pdf')
  const textPath = join(here, 'fixtures', 'min-text-layer.pdf')

  // P1：逐页取图 + 页序/尺寸
  const pageImages = []
  await check('P1', '扫描 PDF 逐页取出图像对象（getOperatorList + objs.get）', async () => {
    const doc = await openDoc(pdfjs, scannedPath)
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const images = await extractImagesFromPage(pdfjs, page)
        pageImages.push({ page: i, images })
        page.cleanup()
      }
    } finally {
      await doc.destroy()
    }
    assertEqSafe(pageImages.length, 3, '页数')
    const sizes = pageImages.map((p) => {
      assertEqSafe(p.images.length, 1, `第 ${p.page} 页应恰有 1 张图`)
      const img = p.images[0].imgData
      assert(typeof img.kind === 'number', 'imgData.kind 存在')
      return `${p.page}:${img.width}x${img.height}:kind${img.kind}`
    })
    const expect = ['1:320x200', '2:320x180', '3:320x160']
    sizes.forEach((s, i) => assert(s.startsWith(expect[i]), `页序/尺寸不符: ${s} != ${expect[i]}*`))
    return sizes.join(' | ')
  })

  // P2：PNG 编码有效（sharp 解码 + 与 pdfjs 位图逐字节一致的往返）
  await check('P2', '手写 PNG 编码可解码，且解码像素与 pdfjs 位图逐字节一致', async () => {
    const { default: sharp } = await import('sharp')
    let summary = ''
    for (const p of pageImages) {
      for (const { imgData } of p.images) {
        const bitmap = imgDataToRgba(imgData)
        const png = encodePng(bitmap)
        assert(png.length > 100, `PNG 字节过少: ${png.length}`)
        assert(png.readUInt32BE(0) === 0x89504e47, 'PNG 签名')
        const meta = await sharp(png).metadata()
        assertEqSafe(meta.format, 'png', `第 ${p.page} 页格式`)
        assertEqSafe(meta.width, imgData.width, `第 ${p.page} 页 PNG 宽`)
        assertEqSafe(meta.height, imgData.height, `第 ${p.page} 页 PNG 高`)
        // 逐字节往返：sharp 解码 RGBA 应与 imgDataToRgba 的输出完全一致（PNG 无损）
        const decoded = await sharp(png).ensureAlpha().raw().toBuffer()
        assertEqSafe(decoded.length, bitmap.rgba.length, `第 ${p.page} 页解码长度`)
        for (let i = 0; i < decoded.length; i++) {
          assertEqSafe(decoded[i], bitmap.rgba[i], `第 ${p.page} 页字节[${i}]`)
        }
        summary += `p${p.page}:${png.length}B,`
      }
    }
    return summary + ' 逐字节往返一致 ✓'
  })

  // P3：data URI 通过 07 imageDataPart 校验
  await check('P3', 'PNG → data URI 形态通过 gatewayClient.imageDataPart 校验', async () => {
    const gwPath = bundleEntry('electron/main/gatewayClient.ts', 'scan-gateway-client.mjs')
    const gw = await import(pathToFileURL(gwPath).href)
    const p = pageImages[0].images[0].imgData
    const dataUri = `data:image/png;base64,${encodePng(imgDataToRgba(p)).toString('base64')}`
    const part = gw.imageDataPart(dataUri)
    assertEqSafe(part.type, 'image_url', 'part.type')
    assert(part.image_url.url.startsWith('data:image/png;base64,'), 'data URI 前缀')
    return `dataURI ${dataUri.length} 字符（base64 内联，§六 images.allowUrl=false 口径）`
  })

  // P4：文字层 PDF 无图像 → 反向判据
  await check('P4', '文字层 PDF 抽出 0 张图（无图 ⇒ 非扫描件判据成立）', async () => {
    const doc = await openDoc(pdfjs, textPath)
    let count = 0
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        count += (await extractImagesFromPage(pdfjs, page)).length
        page.cleanup()
      }
    } finally {
      await doc.destroy()
    }
    assertEqSafe(count, 0, '文字层 PDF 不应有图像绘制指令')
    return '0 张图 ✓'
  })

  results.ok = results.checks.every((c) => c.ok)
  results.finishedAt = new Date().toISOString()
  // 证据回写跟踪文件（基线 v1.29⑥：可审计证据不进 .tmp；churn 由复跑机制解释）
  writeFileSync(join(here, 'probe-scan-render.json'), JSON.stringify(results, null, 2), 'utf-8')
  console.log(`\n===== 探针结论: ${results.ok ? 'PASS（扫描 PDF → PNG 可行）' : 'FAIL（05b 一期降级：只收图片文件）'} =====`)
  process.exit(results.ok ? 0 : 1)
}

main().catch((e) => {
  console.error('探针脚本异常:', e)
  results.error = String(e && e.stack ? e.stack : e)
  try {
    writeFileSync(join(here, 'probe-scan-render.json'), JSON.stringify(results, null, 2), 'utf-8')
  } catch { /* 忽略 */ }
  process.exit(2)
})
