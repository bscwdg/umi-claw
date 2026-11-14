#!/usr/bin/env node
// scripts/umi-plugin.mjs —— `.umi-plugin` 打包/验签 CLI（C1）
//
// 复用宿主同一套 pluginPackage.ts：CLI 不另写 canonical/哈希，避免签名原文漂移。
// 运行时用 esbuild 打临时 ESM（仓库零额外 CLI 依赖），不把 TS 编译产物提交进仓库。

import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const flag = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < args.length && !args[index + 1].startsWith('--')) return args[index + 1]
  if (args.includes(`--${name}`)) return true
  return fallback
}
const fail = (message, code = 1) => {
  console.error(`✗ ${message}`)
  process.exit(code)
}

let packageModule = null
async function loadPackageModule() {
  if (packageModule) return packageModule
  const dir = mkdtempSync(join(resolve('data/tmp'), 'umi-plugin-cli-'))
  const outfile = join(dir, 'pluginPackage.mjs')
  await build({
    entryPoints: [resolve('electron/main/services/pluginPackage.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['electron', 'adm-zip'],
    outfile,
    logLevel: 'silent'
  })
  packageModule = await import(pathToFileURL(outfile).href)
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return packageModule
}

async function main() {
  const pkg = await loadPackageModule()
  if (command === 'keygen') {
    const out = flag('out', 'umi-plugin-key.json')
    const kp = pkg.generateSigningKeyPair()
    writeFileSync(out, JSON.stringify({ ...kp, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ ok: true, out, keyId: kp.keyId, fingerprint: kp.fingerprint }, null, 2))
    return
  }

  if (command === 'pack') {
    const sourceDir = flag('source')
    const outFile = flag('out')
    const keyFile = flag('key-file')
    if (!sourceDir || !outFile || !keyFile) fail('用法：pack --source <dir> --out <file> --key-file <json>')
    if (!existsSync(join(sourceDir, 'plugin.json')) || !existsSync(join(sourceDir, 'main.js'))) {
      fail('source 缺少 plugin.json 或 main.js')
    }
    const key = JSON.parse(readFileSync(keyFile, 'utf8'))
    if (!key.privateKeyPem || !key.keyId) fail('key-file 缺少 privateKeyPem/keyId')
    const signature = pkg.packPlugin({
      sourceDir,
      outFile,
      keyId: key.keyId,
      privateKeyPem: key.privateKeyPem,
      publicKeyBase64: flag('include-public-key') ? key.publicKeyBase64 : undefined,
      createdAt: flag('created-at')
    })
    console.log(JSON.stringify({ ok: true, out: outFile, keyId: signature.keyId, files: signature.files.length }, null, 2))
    return
  }

  if (command === 'verify') {
    const file = flag('file')
    if (!file) fail('用法：verify --file <pkg> [--keyring <json>] [--allow-self-signed] [--tofu <fingerprint>]')
    const keyringFile = flag('keyring')
    const keyring = keyringFile ? pkg.readKeyring(keyringFile) : undefined
    const result = pkg.verifyPluginPackage(file, {
      keyring,
      allowSelfSigned: Boolean(flag('allow-self-signed')),
      tofuFingerprint: flag('tofu')
    })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exit(1)
    return
  }

  console.log(`umi-plugin —— .umi-plugin 打包/验签

用法：
  node scripts/umi-plugin.mjs keygen --out <key.json>
  node scripts/umi-plugin.mjs pack --source <dir> --out <pkg> --key-file <key.json> [--include-public-key] [--created-at <iso>]
  node scripts/umi-plugin.mjs verify --file <pkg> [--keyring <json>] [--allow-self-signed] [--tofu <fingerprint>]
`)
}

main().catch((e) => fail(e?.message ?? String(e)))
