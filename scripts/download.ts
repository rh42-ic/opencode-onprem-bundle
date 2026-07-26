#!/usr/bin/env bun
/**
 * opencode onprem download.ts
 * 预下载所有离线资源：tree-sitter wasm/queries, ripgrep, LSP binaries, npm packages
 *
 * 用法:
 *   bun run scripts/onprem/download.ts --platform linux --arch x64 --out ./assets
 */

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2)
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return undefined
  return args[idx + 1]
}

const platform = getArg("platform") ?? process.platform
const arch = getArg("arch") ?? process.arch
const outDir = getArg("out") ?? "./assets"

function mapArch(a: string): string {
  if (a === "x64") return "x86_64"
  if (a === "arm64") return "aarch64"
  return a
}

function mapPlatform(p: string): string {
  if (p === "win32") return "windows"
  if (p === "darwin") return "macos"
  return p as string
}

// ── ripgrep URL ───────────────────────────────────────────
function getRgTarget(): string {
  const p = mapPlatform(platform)
  const a = mapArch(arch)
  if (p === "linux" && a === "x86_64") return "x86_64-unknown-linux-musl"
  if (p === "linux" && a === "aarch64") return "aarch64-unknown-linux-gnu"
  if (p === "macos" && a === "x86_64") return "x86_64-apple-darwin"
  if (p === "macos" && a === "aarch64") return "aarch64-apple-darwin"
  if (p === "windows" && a === "x86_64") return "x86_64-pc-windows-msvc"
  if (p === "windows" && a === "aarch64") return "aarch64-pc-windows-msvc"
  throw new Error(`Unsupported platform for ripgrep: ${platform}/${arch}`)
}

// ── LSP definitions ───────────────────────────────────────
interface LspDef {
  name: string
  repo: string
  assetPattern: string | ((platform: string, arch: string) => string)
  binaryPath: string
  stripComponents?: number
}

const LSP_DEFS: LspDef[] = [
  {
    name: "rust-analyzer",
    repo: "rust-lang/rust-analyzer",
    assetPattern: (p: string, a: string) => {
      const pa = `${mapArch(a)}-${p === "darwin" ? "apple-darwin" : p === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu"}`
      return `rust-analyzer-${pa}.gz`
    },
    binaryPath: "rust-analyzer",
  },
  {
    name: "clangd",
    repo: "clangd/clangd",
    assetPattern: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "mac" : "windows"
      return `clangd_.*_${plat}_.*\\.(tar\\.gz|zip)`
    },
    binaryPath: "clangd/bin/clangd",
    stripComponents: 1,
  },
  {
    name: "zls",
    repo: "zigtools/zls",
    assetPattern: (p: string, a: string) => {
      const pa = `${mapArch(a)}-${p === "darwin" ? "macos" : p === "win32" ? "windows" : "linux"}`
      return `zls-${pa}\\.(tar\\.gz|tar\\.xz|zip)`
    },
    binaryPath: "zls",
  },
  {
    name: "lua-ls",
    repo: "LuaLS/lua-language-server",
    assetPattern: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "darwin" : "win32"
      const aa = a === "x64" ? "x64" : "arm64"
      return `lua-language-server-.*-${plat}-${aa}\\.tar\\.gz`
    },
    binaryPath: "bin/lua-language-server",
    stripComponents: 0,
  },
  {
    name: "terraform-ls",
    repo: "hashicorp/terraform-ls",
    assetPattern: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "darwin" : "windows"
      const aa = a === "x64" ? "amd64" : "arm64"
      return `terraform-ls_.*_${plat}_${aa}\\.zip`
    },
    binaryPath: "terraform-ls",
  },
  {
    name: "texlab",
    repo: "latex-lsp/texlab",
    assetPattern: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "macos" : "windows"
      const aa = mapArch(a)
      return `texlab-${plat}-${aa}\\.(tar\\.gz|zip)`
    },
    binaryPath: "texlab",
  },
  {
    name: "tinymist",
    repo: "Myriad-Dreamin/tinymist",
    assetPattern: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "darwin" : "win32"
      const aa = mapArch(a)
      return `tinymist-${plat}-${aa}\\.(tar\\.gz|zip)`
    },
    binaryPath: "tinymist",
  },
]

// ── npm packages ──────────────────────────────────────────
const NPM_PACKAGES = [
  "typescript-language-server",
  "@vue/language-server",
  "pyright",
  "svelte-language-server",
  "@astrojs/language-server",
  "yaml-language-server",
  "bash-language-server",
  "dockerfile-language-server-nodejs",
  "intelephense",
  "biome",
  "prettier",
  "@biomejs/biome",
]

// ── helpers ───────────────────────────────────────────────
async function download(url: string, dest: string): Promise<void> {
  console.log(`  ↓ ${url.split("/").pop()}`)
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`)
  const buf = await resp.bytes()
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, buf)
}

async function downloadGithubRelease(repo: string): Promise<any> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  const resp = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "opencode-onprem" },
  })
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${repo}`)
  return resp.json()
}

async function extractArchive(archivePath: string, destDir: string, stripComponents = 0): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true })
  const ext = path.extname(archivePath).toLowerCase()
  const name = path.basename(archivePath)

  if (ext === ".gz" || ext === ".xz") {
    await $`tar -xf ${archivePath} -C ${destDir}`.quiet()
  } else if (ext === ".zip") {
    await $`unzip -qo ${archivePath} -d ${destDir}`.quiet()
  } else {
    // single binary, no extraction needed
    fs.copyFileSync(archivePath, path.join(destDir, name))
    return path.join(destDir, name)
  }

  if (stripComponents > 0) {
    // Flatten by moving files up stripComponents levels
    const entries = fs.readdirSync(destDir, { withFileTypes: true })
    const topDir = entries.find((e) => e.isDirectory())
    if (!topDir) return destDir
    let current = path.join(destDir, topDir.name)
    for (let i = 1; i < stripComponents; i++) {
      const sub = fs.readdirSync(current, { withFileTypes: true }).find((e) => e.isDirectory())
      if (sub) current = path.join(current, sub.name)
    }
    // Move contents of `current` up to destDir
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const src = path.join(current, entry.name)
      const dst = path.join(destDir, entry.name)
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true })
      fs.renameSync(src, dst)
    }
    // Clean up empty dirs
    for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fs.rmSync(path.join(destDir, entry.name), { recursive: true, force: true })
      }
    }
  }
  return destDir
}

// ── main ──────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  opencode onprem download               ║`)
  console.log(`║  platform: ${platform.padEnd(12)} arch: ${arch.padEnd(8)} ║`)
  console.log(`║  output:   ${outDir.padEnd(30)} ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  const stats = { wasm: 0, queries: 0, rg: 0, lsp: 0, npm: 0, plugins: 0 }

  // ── 1. tree-sitter wasm + queries ──────────────────────
  console.log("📦 [1/5] Downloading tree-sitter resources...\n")

  // Dynamically load parsers config from upstream
  const parsersConfigPath = path.resolve(outDir, "../../packages/tui/src/parsers-config.ts")
  const parsersConfig = (await import(parsersConfigPath)).default
  const parsers = parsersConfig.parsers ?? parsersConfig

  // Download wasm files
  const wasmTasks: Promise<void>[] = []
  for (const parser of parsers) {
    const wasmUrl = parser.wasm
    const wasmName = wasmUrl.split("/").pop()
    const dest = path.join(outDir, "tree-sitter", "wasm", wasmName)
    if (!fs.existsSync(dest)) {
      wasmTasks.push(download(wasmUrl, dest).then(() => stats.wasm++))
    } else {
      console.log(`  ✓ wasm/${wasmName} (cached)`)
      stats.wasm++
    }
  }
  await Promise.all(wasmTasks)

  // Download query files
  for (const parser of parsers) {
    const filetype = parser.filetype
    for (const [queryType, urls] of Object.entries(parser.queries)) {
      for (const url of urls as string[]) {
        const queryName = url.split("/").pop() as string
        const dest = path.join(outDir, "tree-sitter", "queries", filetype, queryName)
        if (!fs.existsSync(dest)) {
          await download(url, dest)
          stats.queries++
        } else {
          console.log(`  ✓ queries/${filetype}/${queryName} (cached)`)
          stats.queries++
        }
      }
    }
  }

  // ── 2. ripgrep ─────────────────────────────────────────
  console.log("\n📦 [2/5] Downloading ripgrep...\n")

  const rgTarget = getRgTarget()
  const rgExt = platform === "win32" ? "zip" : "tar.gz"
  const rgVersion = "15.1.0"
  const rgUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}/ripgrep-${rgVersion}-${rgTarget}.${rgExt}`
  const rgDestDir = path.join(outDir, "rg")
  const rgArchive = path.join(outDir, "rg", `ripgrep.${rgExt}`)

  if (!fs.existsSync(path.join(rgDestDir, "rg")) && !fs.existsSync(path.join(rgDestDir, "rg.exe"))) {
    await download(rgUrl, rgArchive)
    await extractArchive(rgArchive, rgDestDir)
    // Find the rg binary
    const findRg = (dir: string): string | undefined => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isFile() && (entry.name === "rg" || entry.name === "rg.exe")) return full
        if (entry.isDirectory()) {
          const found = findRg(full)
          if (found) return found
        }
      }
      return undefined
    }
    const rgBin = findRg(rgDestDir)
    if (rgBin) {
      // Move to rgDir root
      const target = path.join(rgDestDir, path.basename(rgBin))
      if (rgBin !== target) fs.renameSync(rgBin, target)
    }
    // Cleanup
    fs.rmSync(rgArchive, { force: true })
    // Remove leftover dirs
    for (const entry of fs.readdirSync(rgDestDir, { withFileTypes: true })) {
      if (entry.isDirectory()) fs.rmSync(path.join(rgDestDir, entry.name), { recursive: true, force: true })
    }
    stats.rg++
  } else {
    console.log("  ✓ ripgrep (cached)")
    stats.rg++
  }

  // ── 3. GitHub Releases LSP ─────────────────────────────
  console.log("\n📦 [3/5] Downloading LSP binaries...\n")

  for (const lsp of LSP_DEFS) {
    const lspDir = path.join(outDir, "lsp", lsp.name)
    const pattern = typeof lsp.assetPattern === "function" ? lsp.assetPattern(platform, arch) : lsp.assetPattern

    // Check if already exists
    const binaryExists = (() => {
      const parts = lsp.binaryPath.split("/")
      const possible = [
        path.join(lspDir, ...parts),
        path.join(lspDir, lsp.binaryPath),
        path.join(lspDir, parts[parts.length - 1]),
        ...(platform === "win32" ? [path.join(lspDir, parts[parts.length - 1] + ".exe")] : []),
      ]
      return possible.some((p) => fs.existsSync(p))
    })()

    if (binaryExists) {
      console.log(`  ✓ ${lsp.name} (cached)`)
      stats.lsp++
      continue
    }

    try {
      const release = await downloadGithubRelease(lsp.repo)
      const asset = release.assets.find((a: any) => new RegExp(pattern, "i").test(a.name))
      if (!asset) {
        console.log(`  ✗ ${lsp.name}: no asset matching "${pattern}"`)
        continue
      }

      const archivePath = path.join(lspDir, asset.name)
      await download(asset.browser_download_url, archivePath)
      await extractArchive(archivePath, lspDir, lsp.stripComponents ?? 0)
      fs.rmSync(archivePath, { force: true })
      stats.lsp++
      console.log(`  ✓ ${lsp.name}`)
    } catch (e: any) {
      console.log(`  ✗ ${lsp.name}: ${e.message}`)
    }
  }

  // ── 4. npm packages ────────────────────────────────────
  console.log("\n📦 [4/5] Installing npm packages...\n")

  const tmpDir = path.join(outDir, ".tmp-npm")
  fs.mkdirSync(tmpDir, { recursive: true })

  // Read extra plugins from plugins.json
  let extraPlugins: string[] = []
  const pluginsJsonPath = path.resolve(outDir, "../plugins.json")
  if (fs.existsSync(pluginsJsonPath)) {
    const pluginsJson = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf-8"))
    extraPlugins = pluginsJson.plugins ?? []
  }

  const allPackages = [...NPM_PACKAGES, ...extraPlugins]

  for (const pkg of allPackages) {
    const name = pkg.replace("/", "+").replace("@", "")
    const destDir = path.join(outDir, "npm", name)
    if (fs.existsSync(path.join(destDir, "node_modules"))) {
      console.log(`  ✓ ${pkg} (cached)`)
      stats.npm++
      continue
    }

    try {
      const pkgTmp = path.join(tmpDir, name)
      fs.mkdirSync(pkgTmp, { recursive: true })

      // Use bun to install the package
      console.log(`  ↓ ${pkg}`)
      await $`bun add ${pkg}`.cwd(pkgTmp).quiet()

      // Copy node_modules to dest
      const srcNodeModules = path.join(pkgTmp, "node_modules")
      if (fs.existsSync(srcNodeModules)) {
        fs.cpSync(srcNodeModules, path.join(destDir, "node_modules"), { recursive: true })
      } else {
        // Check if bun installed to a global cache
        const bunGlobal = path.join(process.env.HOME ?? "/root", ".bun", "install", "global", "node_modules")
        if (fs.existsSync(path.join(bunGlobal, pkg))) {
          fs.cpSync(bunGlobal, path.join(destDir, "node_modules"), { recursive: true })
        }
      }

      console.log(`  ✓ ${pkg}`)
      stats.npm++
    } catch (e: any) {
      console.log(`  ✗ ${pkg}: ${e.message}`)
    }
  }

  // Cleanup temp
  fs.rmSync(tmpDir, { recursive: true, force: true })

  // ── stats ───────────────────────────────────────────────
  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  Download complete                       ║`)
  console.log(`║  tree-sitter wasm:    ${String(stats.wasm).padEnd(3)}               ║`)
  console.log(`║  tree-sitter queries: ${String(stats.queries).padEnd(3)}               ║`)
  console.log(`║  ripgrep:             ${String(stats.rg).padEnd(3)}               ║`)
  console.log(`║  LSP binaries:        ${String(stats.lsp).padEnd(3)}               ║`)
  console.log(`║  npm packages:        ${String(stats.npm).padEnd(3)}               ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
