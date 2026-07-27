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
  /** 返回该平台必须匹配的关键词列表 */
  keywords: (platform: string, arch: string) => string[]
  /** 优先匹配的文件扩展名 */
  preferExt: string[]
  binaryPath: string
  stripComponents?: number
  /** 非 GitHub Releases 的自定义下载源 */
  customRelease?: () => Promise<{ url: string; name: string }>
}

const LSP_DEFS: LspDef[] = [
  {
    name: "rust-analyzer",
    repo: "rust-lang/rust-analyzer",
    keywords: (p: string, a: string) => {
      const triple = `${mapArch(a)}-${p === "darwin" ? "apple-darwin" : p === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu"}`
      return [triple]
    },
    preferExt: [".gz"],
    binaryPath: "rust-analyzer",
  },
  {
    name: "clangd",
    repo: "clangd/clangd",
    keywords: (p: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "mac" : "windows"
      return ["clangd", plat]
    },
    preferExt: [".tar.gz", ".zip"],
    binaryPath: "clangd/bin/clangd",
    stripComponents: 1,
  },
  {
    name: "zls",
    repo: "zigtools/zls",
    keywords: (p: string, a: string) => {
      const plat = p === "darwin" ? "macos" : p === "win32" ? "windows" : "linux"
      return ["zls", mapArch(a), plat]
    },
    preferExt: [".tar.xz", ".tar.gz", ".zip"],
    binaryPath: "zls",
  },
  {
    name: "lua-ls",
    repo: "LuaLS/lua-language-server",
    keywords: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "darwin" : "win32"
      return ["lua-language-server", plat, a === "x64" ? "x64" : "arm64"]
    },
    preferExt: [".tar.gz"],
    binaryPath: "bin/lua-language-server",
    stripComponents: 0,
  },
  {
    name: "terraform-ls",
    repo: "hashicorp/terraform-ls",
    keywords: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "darwin" : "windows"
      const aa = a === "x64" ? "amd64" : "arm64"
      return ["terraform-ls", plat, aa]
    },
    preferExt: [".zip"],
    binaryPath: "terraform-ls",
    customRelease: async () => downloadHashiCorpRelease("terraform-ls"),
  },
  {
    name: "texlab",
    repo: "latex-lsp/texlab",
    keywords: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "macos" : "windows"
      return ["texlab", plat, mapArch(a)]
    },
    preferExt: [".tar.gz", ".zip"],
    binaryPath: "texlab",
  },
  {
    name: "tinymist",
    repo: "Myriad-Dreamin/tinymist",
    keywords: (p: string, a: string) => {
      const plat = p === "linux" ? "linux" : p === "darwin" ? "darwin" : "win32"
      // tinymist 的 Windows 资产使用 "x64"/"arm64" 命名（如 tinymist-win32-x64.exe），
      // 而非 Rust target triple 的 "x86_64"/"aarch64"
      return ["tinymist", plat, p === "win32" ? a : mapArch(a)]
    },
    preferExt: [".tar.gz", ".zip"],
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

/**
 * 从 "name@spec" 中提取纯 npm 包名。
 * 支持 git URL:  "superpowers@git+https://github.com/obra/superpowers.git" → "superpowers"
 * 支持 scoped:   "@tarquinen/opencode-dcp@latest"   → "@tarquinen/opencode-dcp"
 * 普通包:        "opencode-anthropic-auth@latest"     → "opencode-anthropic-auth"
 */
function extractPackageName(pkg: string): string {
  // scoped package: @scope/name 或 @scope/name@spec
  if (pkg.startsWith("@")) {
    const slash = pkg.indexOf("/")
    if (slash === -1) return pkg
    const after = pkg.indexOf("@", slash)
    return after >= 0 ? pkg.slice(0, after) : pkg
  }
  // non-scoped: name 或 name@spec（包括 git URL）
  const at = pkg.indexOf("@")
  return at >= 0 ? pkg.slice(0, at) : pkg
}

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
  // Retry with exponential backoff for rate limiting (403)
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "opencode-onprem" },
    })
    if (resp.status === 403 && attempt < 2) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") ?? "") || 10
      console.log(`  ⏳ rate limited, waiting ${retryAfter}s...`)
      await new Promise((r) => setTimeout(r, retryAfter * 1000))
      continue
    }
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${repo}`)
    return resp.json()
  }
  throw new Error(`GitHub API 403 (rate limited): ${repo}`)
}

/** HashiCorp releases (terraform-ls etc.) — they don't use GitHub Releases */
async function downloadHashiCorpRelease(product: string): Promise<{ url: string; name: string }> {
  const indexUrl = `https://releases.hashicorp.com/${product}/index.json`
  const resp = await fetch(indexUrl)
  if (!resp.ok) throw new Error(`HashiCorp index ${resp.status}: ${product}`)
  const data: any = await resp.json()
  // Structure: { name, versions: { "0.39.0": { builds: [{os, arch, url, filename}] } } }
  const versions: Record<string, any> = data.versions ?? {}
  const sorted = Object.keys(versions).sort().reverse()
  const latest = sorted[0]
  if (!latest) throw new Error(`No versions for ${product}`)
  const plat = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux"
  const aa = arch === "x64" ? "amd64" : "arm64"
  // Find matching build
  const builds: any[] = versions[latest].builds ?? []
  const match = builds.find((b: any) => b.os === plat && b.arch === aa)
  if (!match) throw new Error(`No ${plat}/${aa} build for ${product} ${latest}`)
  return { url: match.url, name: match.filename }
}

async function extractArchive(archivePath: string, destDir: string, stripComponents = 0): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true })
  const ext = path.extname(archivePath).toLowerCase()
  const name = path.basename(archivePath)

  const isTarGz = name.endsWith(".tar.gz") || name.endsWith(".tgz")
  const isBareGz = ext === ".gz" && !isTarGz

  if (isTarGz || ext === ".xz") {
    await $`tar -xf ${archivePath} -C ${destDir}`.quiet()
  } else if (isBareGz) {
    // bare gzip (e.g. rust-analyzer)
    const outName = name.replace(/\.gz$/, "")
    const outPath = path.join(destDir, outName)
    await $`gunzip -c ${archivePath} > ${outPath}`.quiet()
    fs.chmodSync(outPath, 0o755)
    return outPath
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
    // Only remove the original archive top-level directory (now empty)
    fs.rmSync(path.join(destDir, topDir.name), { recursive: true, force: true })
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

  const stats = { wasm: 0, queries: 0, rg: 0, lsp: 0, npm: 0, shim: 0, plugins: 0 }

  // ── 1. tree-sitter wasm + queries ──────────────────────
  console.log("📦 [1/5] Downloading tree-sitter resources...\n")

  // Dynamically load parsers config from upstream
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const parsersConfigPath = path.resolve(__dirname, "../../packages/tui/src/parsers-config.ts")
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
      let archiveName: string
      let downloadUrl: string

      if (lsp.customRelease) {
        const cr = await lsp.customRelease()
        archiveName = cr.name
        downloadUrl = cr.url
      } else {
        const release = await downloadGithubRelease(lsp.repo)
        const keywords = lsp.keywords(platform, arch).map((k) => k.toLowerCase())

        // Filter assets: ALL keywords must appear in the name
        const candidates = (release.assets as any[])
          .filter((a: any) => {
            const name = a.name.toLowerCase()
            return keywords.every((kw) => name.includes(kw))
          })
          // Sort by preferred extension, then penalize "docs" / "source" (non-binary) assets
          .sort((a: any, b: any) => {
            const aIdx = lsp.preferExt.findIndex((ext) => a.name.endsWith(ext))
            const bIdx = lsp.preferExt.findIndex((ext) => b.name.endsWith(ext))
            const extScore = (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx)
            if (extScore !== 0) return extScore
            // Prefer non-docs assets
            const aDocs = /docs|source|viewer/i.test(a.name) ? 1 : 0
            const bDocs = /docs|source|viewer/i.test(b.name) ? 1 : 0
            return aDocs - bDocs
          })

        const asset = candidates[0]
        if (!asset) {
          console.log(`  ✗ ${lsp.name}: no asset matching keywords [${keywords.join(", ")}]`)
          console.log(`    available: ${(release.assets as any[]).map((a: any) => a.name).join(", ")}`)
          continue
        }
        archiveName = asset.name
        downloadUrl = asset.browser_download_url
      }

      const archivePath = path.join(lspDir, archiveName)
      const extracted = await download(downloadUrl, archivePath).then(() =>
        extractArchive(archivePath, lspDir, lsp.stripComponents ?? 0),
      )
      fs.rmSync(archivePath, { force: true })

      // rust-analyzer bare .gz extracts to a file with arch suffix; rename to expected name
      const expectedBin = path.join(lspDir, lsp.binaryPath.split("/").pop()!)
      if (!fs.existsSync(expectedBin) && extracted && fs.existsSync(extracted) && fs.statSync(extracted).isFile() && extracted !== expectedBin) {
        fs.renameSync(extracted, expectedBin)
      }

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

  // Read extra plugins from plugins.json (relative to upstream root)
  let extraPlugins: string[] = []
  const pluginsJsonPath = path.resolve(__dirname, "plugins.json")
  if (fs.existsSync(pluginsJsonPath)) {
    const pluginsJson = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf-8"))
    extraPlugins = pluginsJson.plugins ?? []
  }

  const allPackages = [...NPM_PACKAGES, ...extraPlugins]

  for (const pkg of allPackages) {
    const safeName = extractPackageName(pkg).replace("/", "+")
    const destDir = path.join(outDir, "npm", safeName)
    if (fs.existsSync(path.join(destDir, "node_modules"))) {
      console.log(`  ✓ ${pkg} (cached)`)
      stats.npm++
      continue
    }

    try {
      const pkgTmp = path.join(tmpDir, safeName)
      fs.mkdirSync(pkgTmp, { recursive: true })

      // Create minimal package.json so bun add works
      fs.writeFileSync(
        path.join(pkgTmp, "package.json"),
        JSON.stringify({ name: `tmp-${safeName}`, private: true }, null, 2),
      )

      // Install the package (point bun cache to writable tmp)
      console.log(`  ↓ ${pkg}`)
      await $`bun add ${pkg}`.cwd(pkgTmp).env({
        ...process.env,
        BUN_INSTALL_CACHE_DIR: path.join(tmpDir, ".bun-cache"),
      }).quiet()

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

  // ── 5. shim.exe (Windows only) ─────────────────────────
  if (platform === "win32") {
    console.log("\n📦 [6/6] Downloading shim.exe (ScoopInstaller/Shim)...\n")

    const shimVersion = "cpp/v0.1.1"
    const shimArch = arch === "arm64" ? "arm64" : "x64"
    const shimUrl = `https://github.com/ScoopInstaller/Shim/releases/download/${shimVersion}/shim-${shimArch}.zip`
    const shimDir = path.join(outDir, "shim-tmp")

    if (!fs.existsSync(path.join(outDir, "shim.exe"))) {
      try {
        const shimZip = path.join(shimDir, "shim.zip")
        await download(shimUrl, shimZip)
        await extractArchive(shimZip, shimDir)
        // Find shim.exe and move to assets root
        const findShim = (dir: string): string | undefined => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isFile() && entry.name === "shim.exe") return full
            if (entry.isDirectory()) {
              const found = findShim(full)
              if (found) return found
            }
          }
          return undefined
        }
        const shimExe = findShim(shimDir)
        if (shimExe) {
          fs.renameSync(shimExe, path.join(outDir, "shim.exe"))
        }
        fs.rmSync(shimDir, { recursive: true, force: true })
        stats.shim++
        console.log("  ✓ shim.exe")
      } catch (e: any) {
        console.log(`  ✗ shim.exe: ${e.message}`)
      }
    } else {
      console.log("  ✓ shim.exe (cached)")
      stats.shim++
    }
  }

  // ── stats ───────────────────────────────────────────────
  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  Download complete                       ║`)
  console.log(`║  tree-sitter wasm:    ${String(stats.wasm).padEnd(3)}               ║`)
  console.log(`║  tree-sitter queries: ${String(stats.queries).padEnd(3)}               ║`)
  console.log(`║  ripgrep:             ${String(stats.rg).padEnd(3)}               ║`)
  console.log(`║  LSP binaries:        ${String(stats.lsp).padEnd(3)}               ║`)
  console.log(`║  npm packages:        ${String(stats.npm).padEnd(3)}               ║`)
  console.log(`║  shim.exe (Win only): ${String(stats.shim).padEnd(3)}               ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
