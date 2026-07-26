/**
 * onprem-gate.ts — onprem 门禁逻辑
 *
 * 提供 onprem 模式下 npm 包查找和网络安装阻断功能。
 * 此模块与 Patch 2 (npm.ts) 的逻辑保持一致，可作为独立 reference 使用。
 */

import path from "path"
import fs from "fs"

/**
 * 检查文件或目录是否存在（同步）
 */
export function existsSync(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/**
 * 是否为 onprem 模式
 */
export const isOnprem = !!process.env.OPENCODE_ONPREM_DIR

/**
 * 获取 onprem 基础目录
 */
export function getOnpremDir(): string | undefined {
  return process.env.OPENCODE_ONPREM_DIR
}

/**
 * 查找包目录
 *
 * 查找优先级: onprem 预置目录 → 用户缓存目录 → undefined
 */
export function findPackageDir(pkg: string, cacheDir?: string): string | undefined {
  const name = sanitize(pkg)
  const onpremBase = process.env.OPENCODE_ONPREM_DIR
  if (onpremBase) {
    const onpremDir = path.join(onpremBase, "assets", "npm", name)
    if (existsSync(path.join(onpremDir, "node_modules"))) return onpremDir
  }
  if (cacheDir) {
    const dir = path.join(cacheDir, "packages", name)
    if (existsSync(path.join(dir, "node_modules"))) return dir
  }
  return undefined
}

/**
 * 清理包名中的特殊字符（与 npm.ts 中的 sanitize 保持一致）
 */
export function sanitize(pkg: string): string {
  return pkg.replace(/[@/]/g, "+")
}

/**
 * 检查是否为 onprem 模式并已验证环境变量
 */
export function validateOnprem(): { valid: boolean; dir?: string; reason?: string } {
  const dir = process.env.OPENCODE_ONPREM_DIR
  if (!dir) {
    return { valid: false, reason: "OPENCODE_ONPREM_DIR is not set" }
  }
  if (!existsSync(dir)) {
    return { valid: false, dir, reason: `OPENCODE_ONPREM_DIR does not exist: ${dir}` }
  }
  return { valid: true, dir }
}
