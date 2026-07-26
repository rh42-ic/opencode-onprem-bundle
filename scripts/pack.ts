#!/usr/bin/env bun
/**
 * opencode onprem pack.ts
 * 编译 CLI + Desktop，打包为自包含离线 bundle
 *
 * 用法:
 *   bun run scripts/onprem/pack.ts --platform linux --arch x64
 *
 * 输出:
 *   dist/opencode-onprem-v<version>-<platform>-<arch>.tar.zst
 */

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

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
  const binDest = path.join(bundleDir, "bin", "opencode")

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
  const buildEnv = { ...process.env, OPENCODE_VERSION: version, OPENCODE_CHANNEL: "dev" }

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

async function createSymlinks(bundleDir: string) {
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

  // ── Phase B: Build Desktop ────────────────────────────
  await buildDesktop(bundleDir, buildVersion)

  // ── Phase C: Download assets ──────────────────────────
  console.log("📦 Phase C: Downloading assets...\n")

  const downloadScript = path.join(rootDir, "scripts", "onprem", "download.ts")
  const assetsDir = path.join(bundleDir, "assets")

  if (!dryRun) {
    await $`bun run ${downloadScript} --platform ${platform} --arch ${arch} --out ${assetsDir}`.cwd(rootDir)
  }

  // ── Create symlinks ──────────────────────────────────
  await createSymlinks(bundleDir)

  // ── Copy env.sh ──────────────────────────────────────
  const envSrc = path.join(__dirname, "env.sh")
  const envDest = path.join(bundleDir, "env.sh")
  if (!dryRun) {
    fs.copyFileSync(envSrc, envDest)
  }
  console.log(`\n📋 Copied env.sh to bundle\n`)

  // ── Package ──────────────────────────────────────────
  console.log("📦 Packaging...")

  const isWin = platform === "win32"
  const archiveName = isWin ? `${bundleName}.7z` : `${bundleName}.tar.zst`
  const archivePath = path.join(rootDir, "dist", archiveName)

  if (!dryRun) {
    if (isWin) {
      // Windows: 7z 容器 + zstd 压缩，用户可用 7-Zip/WinRAR 直接打开
      await $`7z a -tzstd ${archivePath} ${bundleDir}`.cwd(path.join(rootDir, "dist")).quiet()
    } else {
      // Linux/macOS: tar 归档 + zstd 压缩
      await $`tar --zstd -cf ${archivePath} -C ${path.join(rootDir, "dist")} ${bundleName}`.quiet()
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
