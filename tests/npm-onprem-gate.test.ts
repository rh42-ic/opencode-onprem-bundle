// npm-onprem-gate.test.ts
// onprem npm 门禁冒烟测试：验证 Npm.add()/Npm.install() 在 onprem 模式下的行为
//
// 运行方式（在 upstream 仓库中）：
//   cp 本文件到 packages/core/ 下，然后：
//   cd packages/core && bun run npm-onprem-gate.test.ts
//
// 场景：
//   A  install: 默认 registry + 预置命中 → 从预置目录拷贝（不联网）
//   B  install: 默认 registry + 未预置 → 跳过不抛错（不阻塞启动）
//   C  install: 镜像 registry + 预置命中 → 拷贝优先（不重新下载）
//   C2 install: 镜像 registry + 未预置 → 放行 reify（网络安装）
//   D  add: 预置命中 → 预置路径
//   E  add: 未预置 → InstallFailedError
//   F  add: 镜像 + 未预置 → 放行 reify（cache 路径）
//
// 注意：C2/F 需要网络（真实从镜像下载）；A/B/C/D/E 完全离线可跑。

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const DEFAULT_REGISTRY = "https://registry.npmjs.org"
const MIRROR_REGISTRY = "https://registry.npmmirror.com"
const PRELOADED = "@opencode-ai/plugin"
const UNPRELOADED = "is-number@7.0.0"

// ── 环境准备（必须在 import npm.ts 之前设置 OPENCODE_ONPREM_DIR）──
const tmpRoot = path.join(os.tmpdir(), "opencode-onprem-test")
process.env.OPENCODE_ONPREM_DIR = tmpRoot
const preloadedDir = path.join(tmpRoot, "assets", "npm", PRELOADED.replace("/", "+"), "node_modules", PRELOADED)
mkdirSync(preloadedDir, { recursive: true })
writeFileSync(path.join(preloadedDir, "package.json"), JSON.stringify({ name: PRELOADED, version: "1.18.21" }))
writeFileSync(path.join(preloadedDir, "MARKER.txt"), "preloaded")

// 动态 import：静态 import 会在设置 env 之前求值模块级 isOnprem 常量
const { Npm } = await import("./src/npm")

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

function setRegistry(registry: string) {
  process.env.npm_config_registry = registry
}

function mkProject(name: string) {
  const dir = path.join(tmpRoot, "projects", name)
  mkdirSync(dir, { recursive: true })
  return dir
}

// A: install 默认 registry + 预置命中 → 从预置目录拷贝（不联网）
async function scenarioA() {
  const dir = mkProject("A")
  setRegistry(DEFAULT_REGISTRY)
  await Npm.install(dir, { add: [{ name: PRELOADED, version: "1.18.21" }] })
  check("A install 默认 registry + 预置命中 → 拷贝", existsSync(path.join(dir, "node_modules", PRELOADED, "MARKER.txt")))
}

// B: install 默认 registry + 未预置 → 跳过不抛错（不阻塞启动）
async function scenarioB() {
  const dir = mkProject("B")
  setRegistry(DEFAULT_REGISTRY)
  await Npm.install(dir, { add: [{ name: "is-number", version: "7.0.0" }] })
  check("B install 默认 registry + 未预置 → 跳过", !existsSync(path.join(dir, "node_modules")))
}

// C: install 镜像 registry + 预置命中 → 拷贝优先（不重新下载）
async function scenarioC() {
  const dir = mkProject("C")
  setRegistry(MIRROR_REGISTRY)
  await Npm.install(dir, { add: [{ name: PRELOADED, version: "1.18.21" }] })
  check("C install 镜像 + 预置命中 → 拷贝优先", existsSync(path.join(dir, "node_modules", PRELOADED, "MARKER.txt")))
}

// C2: install 镜像 registry + 未预置 → 放行 reify（网络安装）
async function scenarioC2() {
  const dir = mkProject("C2")
  setRegistry(MIRROR_REGISTRY)
  await Npm.install(dir, { add: [{ name: "is-number", version: "7.0.0" }] })
  check("C2 install 镜像 + 未预置 → 放行 reify", existsSync(path.join(dir, "node_modules", "is-number", "package.json")))
}

// D: add 预置命中 → 预置路径
async function scenarioD() {
  setRegistry(DEFAULT_REGISTRY)
  const entry = await Npm.add(PRELOADED)
  check("D add 预置命中 → 预置路径", typeof entry === "object" && entry.directory === preloadedDir)
}

// E: add 未预置（默认 registry）→ InstallFailedError
async function scenarioE() {
  setRegistry(DEFAULT_REGISTRY)
  try {
    await Npm.add(UNPRELOADED)
    check("E add 未预置 → InstallFailedError", false, "(未抛错)")
  } catch (e) {
    const tag = e && typeof e === "object" && "_tag" in e ? (e as { _tag: string })._tag : ""
    check("E add 未预置 → InstallFailedError", tag === "NpmInstallFailedError", `(tag=${tag})`)
  }
}

// F: add 镜像 + 未预置 → 放行 reify（cache 路径）
async function scenarioF() {
  setRegistry(MIRROR_REGISTRY)
  const cacheDir = path.join(os.homedir(), ".cache", "opencode", "packages", "is-number")
  const entry = await Npm.add("is-number")
  check(
    "F add 镜像 + 未预置 → 放行 reify",
    typeof entry === "object" && entry.directory.includes("is-number") && existsSync(path.join(cacheDir, "node_modules", "is-number", "package.json")),
  )
  rmSync(cacheDir, { recursive: true, force: true })
}

console.log("\n📦 onprem npm 门禁冒烟测试\n")
try {
  await scenarioA()
  await scenarioB()
  await scenarioC()
  await scenarioC2()
  await scenarioD()
  await scenarioE()
  await scenarioF()
} finally {
  rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)