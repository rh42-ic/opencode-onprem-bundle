#!/usr/bin/env bun
/**
 * opencode onprem pack.ts
 * 编译 CLI + Desktop，打包为自包含离线 bundle
 *
 * 用法:
 *   bun run scripts/onprem/pack.ts --platform linux --arch x64
 *
 *   可选:
 *   --desktop   编译 Desktop (Electron) 版本（默认跳过）
 *   --dry-run   仅模拟，不执行实际构建
 *
 * 输出:
 *   dist/opencode-onprem-v<version>-<platform>-<arch>.tar.zst (或 .7z)
 */

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { fileTypeFromFile } from "file-type"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..", "..")

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2)
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return undefined
  return args[idx + 1]
}

const platform = getArg("platform") ?? process.platform
const arch = getArg("arch") ?? process.arch
const dryRun = args.includes("--dry-run")
const withDesktop = args.includes("--desktop")

// ── helpers ───────────────────────────────────────────────
function readManifest() {
  // manifest.json 由 CI workflow 复制到 scripts/onprem/ 中
  const manifestPath = path.join(__dirname, "manifest.json")
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
}

async function checkPatchesApplied(): Promise<boolean> {
  // Quick check: look for the ONPREM constant in parsers-config.ts
  const parsersConfig = path.join(rootDir, "packages", "tui", "src", "parsers-config.ts")
  if (!fs.existsSync(parsersConfig)) return false
  const content = fs.readFileSync(parsersConfig, "utf-8")
  return content.includes("const ONPREM =")
}

async function applyPatches() {
  // patches 应由 CI workflow 在调用 pack.ts 前通过 git apply 应用
  console.error("  ✗ Patches not applied! Run 'git apply patches/*.patch' in upstream first.")
  process.exit(1)
}

async function buildCli(bundleDir: string, version: string) {
  console.log("🔨 Phase A: Building CLI...\n")

  process.chdir(path.join(rootDir, "packages", "opencode"))
  if (!dryRun) {
    await $`bun run build --single --skip-install`.cwd(process.cwd()).env({ ...process.env, OPENCODE_VERSION: version })
  }

  // Find the built binary
  const distDir = path.join(process.cwd(), "dist")
  const entries = fs.readdirSync(distDir, { withFileTypes: true })
  const buildDir = entries.find((e) => {
    if (!e.isDirectory()) return false
    // Match the target platform/arch pattern, e.g. "opencode-linux-x64"
    const name = e.name.toLowerCase()
    const p = platform === "win32" ? "windows" : platform
    return name.includes(p) && name.includes(arch)
  })

  if (!buildDir) {
    console.error("  ✗ Could not find build output directory")
    console.error("  Available:", entries.filter((e) => e.isDirectory()).map((e) => e.name))
    process.exit(1)
  }

  const binaryName = platform === "win32" ? "opencode.exe" : "opencode"
  const binSrc = path.join(distDir, buildDir.name, "bin", binaryName)
  const binDest = path.join(bundleDir, "bin", binaryName)

  if (!dryRun) {
    fs.mkdirSync(path.dirname(binDest), { recursive: true })
    fs.copyFileSync(binSrc, binDest)
    fs.chmodSync(binDest, 0o755)
  }

  console.log(`  ✓ CLI binary: ${binDest}\n`)
  return buildDir.name
}

async function buildDesktop(bundleDir: string, version: string) {
  console.log("🔨 Phase B: Building Desktop...\n")
  const buildEnv = { ...process.env, OPENCODE_VERSION: version }

  // Step 1: Build opencode node bundle
  console.log("  [1/4] Building opencode node bundle...")
  process.chdir(path.join(rootDir, "packages", "opencode"))
  if (!dryRun) {
    await $`bun run script/build-node.ts`.cwd(process.cwd()).env(buildEnv).quiet()
  }
  console.log("  ✓ node bundle built")

  // Step 2: Build frontend SPA
  console.log("  [2/4] Building frontend SPA...")
  const appDir = path.join(rootDir, "packages", "app")
  if (!dryRun) {
    await $`bun run build`.cwd(appDir).env(buildEnv).quiet()
  }
  console.log("  ✓ SPA built")

  // Step 3: Build desktop (electron-vite)
  console.log("  [3/4] Building desktop (electron-vite)...")
  const desktopDir = path.join(rootDir, "packages", "desktop")
  if (!dryRun) {
    await $`bun run prebuild`.cwd(desktopDir).env(buildEnv).quiet()
    await $`bun run build`.cwd(desktopDir).env(buildEnv).quiet()
  }
  console.log("  ✓ Desktop built")

  // Step 4: Package with electron-builder --dir
  console.log("  [4/4] Packaging desktop...")
  if (!dryRun) {
    const buildArgs = [
      "--config", "electron-builder.config.ts",
    ]

    // Platform-specific args
    if (platform === "linux") buildArgs.push("--linux")
    else if (platform === "darwin") buildArgs.push("--mac")
    else if (platform === "win32") buildArgs.push("--win")

    buildArgs.push("--dir")

    await $`npx electron-builder ${buildArgs}`.cwd(desktopDir)
      .env({
        ...buildEnv,
        ...(platform === "darwin" ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" } : {}),
      })
      .quiet()
  }

  // Find the unpacked directory
  const distDir = path.join(desktopDir, "dist")
  let unpackedDir: string | undefined
  if (!dryRun) {
    const candidates = fs.readdirSync(distDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    const preferred = platform === "linux" ? "linux-unpacked"
      : platform === "darwin" ? "mac"
      : "win-unpacked"

    unpackedDir = candidates.find((e) => e.name.includes(preferred))?.name
    if (!unpackedDir) {
      // Fallback to any directory that doesn't look like a platform-specific build dir
      const excludes = new Set(["mac", "mac-arm64", "linux-unpacked", "win-unpacked", "builder-effective-config.yaml"])
      unpackedDir = candidates.find((e) => !excludes.has(e.name))?.name
    }
  }

  if (!unpackedDir) {
    console.log("  ⚠ No electron-builder output found (may have already been built)")
    return
  }

  const srcDir = path.join(distDir, unpackedDir)
  const destDir = path.join(bundleDir, "desktop")

  if (!dryRun) {
    // Copy the unpacked desktop app
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true })
    fs.cpSync(srcDir, destDir, { recursive: true })
  }

  console.log(`  ✓ Desktop: ${destDir}\n`)
}

async function createSymlinks(bundleDir: string, platform: string) {
  if (platform === "win32") {
    console.log("🔗 Windows: creating Scoop-style shims...\n")
    await createShims(bundleDir)
    return
  }

  console.log("🔗 Creating symlinks...\n")
  const binDir = path.join(bundleDir, "bin")

  const symlinks: Record<string, string> = {
    rg: "../assets/rg/rg",
    "rust-analyzer": "../assets/lsp/rust-analyzer/rust-analyzer",
    clangd: "../assets/lsp/clangd/bin/clangd",
    zls: "../assets/lsp/zls/zls",
    "lua-language-server": "../assets/lsp/lua-ls/bin/lua-language-server",
    "terraform-ls": "../assets/lsp/terraform-ls/terraform-ls",
    texlab: "../assets/lsp/texlab/texlab",
    tinymist: "../assets/lsp/tinymist/tinymist",
    // npm-based LSP
    "typescript-language-server": "../assets/npm/typescript-language-server/node_modules/.bin/typescript-language-server",
    "vue-language-server": "../assets/npm/@vue+language-server/node_modules/.bin/vue-language-server",
    "pyright-langserver": "../assets/npm/pyright/node_modules/.bin/pyright-langserver",
    svelteserver: "../assets/npm/svelte-language-server/node_modules/.bin/svelteserver",
    "astro-ls": "../assets/npm/@astrojs+language-server/node_modules/.bin/astro-ls",
    "yaml-language-server": "../assets/npm/yaml-language-server/node_modules/.bin/yaml-language-server",
    "bash-language-server": "../assets/npm/bash-language-server/node_modules/.bin/bash-language-server",
    "docker-langserver": "../assets/npm/dockerfile-language-server-nodejs/node_modules/.bin/docker-langserver",
    intelephense: "../assets/npm/intelephense/node_modules/.bin/intelephense",
    biome: "../assets/npm/biome/node_modules/.bin/biome",
    prettier: "../assets/npm/prettier/node_modules/.bin/prettier",
  }

  for (const [name, target] of Object.entries(symlinks)) {
    const linkPath = path.join(binDir, name)
    if (!dryRun) {
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath)
      fs.symlinkSync(target, linkPath)
    }
    console.log(`  ${name} → ${target}`)
  }
}

/** Windows: native LSP 用 Scoop-style shim，rg 直接复制到 bin/ */
async function createShims(bundleDir: string) {
  const binDir = path.join(bundleDir, "bin")
  const shimExeSrc = path.join(bundleDir, "assets", "shim.exe")

  if (!fs.existsSync(shimExeSrc)) {
    console.log("  ⚠ shim.exe not found in assets/, skipping\n")
    return
  }

  // rg 高频调用，直接复制，不经过 shim
  const rgSrc = path.join(bundleDir, "assets", "rg", "rg.exe")
  if (fs.existsSync(rgSrc)) {
    fs.copyFileSync(rgSrc, path.join(binDir, "rg.exe"))
    console.log(`  rg.exe (copy) → assets\\rg\\rg.exe`)
  }

  // npm LSP（typescript-language-server 等）走 Npm.which() 直接拿
  // node_modules/.bin/xxx.cmd 路径，不经过 bin/，因此不需要 shim。
  // 这里只为 native LSP 创建 shim。
  const tools = [
    { name: "rust-analyzer", path: "assets\\lsp\\rust-analyzer\\rust-analyzer" },
    { name: "clangd", path: "assets\\lsp\\clangd\\bin\\clangd" },
    { name: "zls", path: "assets\\lsp\\zls\\zls" },
    { name: "lua-language-server", path: "assets\\lsp\\lua-ls\\bin\\lua-language-server" },
    { name: "terraform-ls", path: "assets\\lsp\\terraform-ls\\terraform-ls" },
    { name: "texlab", path: "assets\\lsp\\texlab\\texlab" },
    { name: "tinymist", path: "assets\\lsp\\tinymist\\tinymist" },
  ]

  for (const tool of tools) {
    const absBase = path.join(bundleDir, tool.path)
    let relPath: string
    if (fs.existsSync(absBase + ".exe")) {
      relPath = tool.path + ".exe"
    } else if (fs.existsSync(absBase)) {
      relPath = tool.path
    } else {
      relPath = tool.path + ".exe" // fallback
    }

    const shimCfg = `path = "%OPENCODE_ONPREM_DIR%\\${relPath}"\n`
    const shimExeDest = path.join(binDir, tool.name + ".exe")
    const shimCfgDest = path.join(binDir, tool.name + ".shim")

    if (!dryRun) {
      fs.copyFileSync(shimExeSrc, shimExeDest)
      fs.writeFileSync(shimCfgDest, shimCfg)
    }
    console.log(`  ${tool.name}.exe → ${relPath}`)
  }
}

/** 收集 bundle 内文件，按扩展名/MIME 排序以提升 zstd 压缩率 */
async function buildSortedFileList(bundleDir: string, bundleName: string): Promise<string> {
  const glob = new Bun.Glob("**/*")
  const entries = Array.from(glob.scanSync({ cwd: bundleDir, onlyFiles: false, dot: true }))

  const getExt = (f: string): string => {
    const m = path.basename(f).match(/(?<=.)\.([^./\\]+)(?:\.\d+)*$/)
    return m && !/^\d+$/.test(m[1]) ? "." + m[1].toLowerCase() : ""
  }

  // 无扩展名文件用 file-type read-chunk (Magic Bytes) 探测 MIME，同类文件聚在一起
  const noExtFiles = entries.filter((e) => !getExt(e))
  const mimeMap = new Map<string, string>()
  if (noExtFiles.length > 0) {
    console.log(`  Detecting MIME for ${noExtFiles.length} extensionless files...`)
    const BATCH = 32
    for (let i = 0; i < noExtFiles.length; i += BATCH) {
      const batch = noExtFiles.slice(i, i + BATCH)
      const results = await Promise.all(
        batch.map(async (f) => {
          try {
            const r = await fileTypeFromFile(path.join(bundleDir, f))
            return r?.mime ?? ""
          } catch {
            return ""
          }
        }),
      )
      batch.forEach((f, j) => mimeMap.set(f, results[j]))
    }
  }

  entries.sort((a, b) => {
    const tA = getExt(a) || mimeMap.get(a) || ""
    const tB = getExt(b) || mimeMap.get(b) || ""
    return tA !== tB ? tA.localeCompare(tB) : a.localeCompare(b)
  })

  // 首行空串 = tar 约定：包含目录本身
  entries.unshift("")
  return entries.map((e) => path.join(bundleName, e)).join("\n")
}

// ── main ──────────────────────────────────────────────────
async function main() {
  const manifest = readManifest()
  const version = manifest.version
  const buildVersion = `${version}-onprem`
  const bundleName = `opencode-onprem-v${version}-${platform}-${arch}`
  const bundleDir = path.join(rootDir, "dist", bundleName)

  console.log(`\n╔══════════════════════════════════════════════════╗`)
  console.log(`║  opencode onprem pack                            ║`)
  console.log(`║  version:  ${buildVersion.padEnd(35)} ║`)
  console.log(`║  platform: ${platform.padEnd(35)} ║`)
  console.log(`║  arch:     ${arch.padEnd(35)} ║`)
  console.log(`║  output:   ${bundleDir}  ║`)
  console.log(`╚══════════════════════════════════════════════════╝\n`)

  // ── Check / Apply patches ─────────────────────────────
  console.log("📋 Checking patches...")
  if (!(await checkPatchesApplied())) {
    console.log("  Patches not applied, applying...")
    await applyPatches()
  } else {
    console.log("  ✓ Patches already applied\n")
  }

  // ── Create bundle dir ─────────────────────────────────
  if (!dryRun) {
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.mkdirSync(path.join(bundleDir, "bin"), { recursive: true })
  }

  // ── Phase A: Build CLI ────────────────────────────────
  await buildCli(bundleDir, buildVersion)

  // ── Phase B: Build Desktop (optional) ──────────────
  if (withDesktop) {
    await buildDesktop(bundleDir, buildVersion)
  } else {
    console.log("🔨 Phase B: Skipping Desktop (use --desktop to build)\n")
  }

  // ── Phase C: Download assets ──────────────────────────
  console.log("📦 Phase C: Downloading assets...\n")

  const downloadScript = path.join(rootDir, "scripts", "onprem", "download.ts")
  const assetsDir = path.join(bundleDir, "assets")

  if (!dryRun) {
    await $`bun run ${downloadScript} --platform ${platform} --arch ${arch} --out ${assetsDir}`.cwd(rootDir)
  }

  // ── Create symlinks ──────────────────────────────────
  await createSymlinks(bundleDir, platform)

  // ── Copy env scripts (platform-specific) ───────────
  const envFiles = platform === "win32"
    ? ["env.bat", "env.ps1"]
    : ["env.sh"]

  for (const name of envFiles) {
    const envSrc = path.join(__dirname, name)
    const envDest = path.join(bundleDir, name)
    if (!dryRun) {
      if (fs.existsSync(envSrc)) {
        fs.copyFileSync(envSrc, envDest)
        console.log(`  ✓ ${name}`)
      }
    }
  }
  console.log(`\n📋 Copied env scripts to bundle\n`)

  // ── Package ──────────────────────────────────────────
  console.log("📦 Packaging...")

  const isWin = platform === "win32"
  const archiveName = isWin ? `${bundleName}.7z` : `${bundleName}.tar.zst`
  const archivePath = path.join(rootDir, "dist", archiveName)

  if (!dryRun) {
    if (isWin) {
      // Windows: 标准 7z（LZMA2），任何 7-Zip/WinRAR 均可打开
      await $`7z a ${archivePath} ${bundleDir}`.cwd(path.join(rootDir, "dist")).quiet()
    } else {
      // Linux/macOS: 按类型排序后 tar + zstd 最高压缩（级别 19，全核）
      const listPath = path.join(rootDir, "dist", `.${bundleName}.list`)
      const fileList = await buildSortedFileList(bundleDir, bundleName)
      fs.writeFileSync(listPath, fileList)
      const zstdCompress = "zstd -19 -T0 --long"
      await $`tar --no-recursion --checkpoint=1000 --checkpoint-action=dot -I ${zstdCompress} -cf ${archivePath} -T ${listPath}`.cwd(path.join(rootDir, "dist"))
      fs.unlinkSync(listPath)
    }
  }

  console.log(`\n╔══════════════════════════════════════════════════╗`)
  console.log(`║  Pack complete!                                  ║`)
  console.log(`║  ${archiveName.padEnd(48)} ║`)
  console.log(`╚══════════════════════════════════════════════════╝\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
