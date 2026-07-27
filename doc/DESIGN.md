# opencode-onprem-bundle 设计文档

## 目标

将 opencode 打包为自包含的离线 bundle，同时包含 CLI 和 Desktop 版本。用户在 air-gap 环境中 `source env.sh` 即可使用，无需任何网络访问。

## 工程结构

```
opencode-dev/
├── opencode-onprem-bundle/           # 补丁工程（本目录）
│   ├── DESIGN.md                     # 本文档
│   ├── README.md                     # 使用说明
│   ├── manifest.json                 # 版本/兼容性声明
│   ├── patches/
│   │   ├── 001-parsers-config.patch  # 修改 parsers-config.ts
│   │   └── 002-npm-onprem-gate.patch # 修改 npm.ts
│   ├── scripts/
│   │   ├── download.ts               # 预下载脚本
│   │   ├── pack.ts                   # 编译 + 打包脚本
│   │   └── env.sh                    # bundle 环境文件模板
│   ├── src/                          # 附加源码（runtime 补丁）
│   │   └── onprem-gate.ts            # onprem 门禁逻辑
│   └── plugins.json                  # 额外插件声明
└── opencode-1.18.7/                  # upstream（用于开发和测试）
```

### 工作流

```
1. 在 upstream 中编辑源码
2. git diff 生成 patch → 覆盖 patches/
3. cp scripts/* → upstream/scripts/onprem/
4. 在 upstream 中运行 bun run scripts/onprem/pack.ts
5. 输出 opencode-onprem-v1.18.7-linux-x64.tar.zst（含 CLI + Desktop）
```

---

## 源码修改（2 个 patch）

### Patch 1: `packages/tui/src/parsers-config.ts`

**目的**: 在 `OPENCODE_ONPREM_DIR` 已设置时，将 tree-sitter wasm 和 query 的远程 URL 映射为本地路径。

**方案**: 在文件顶部新增 `localize()` 函数，对 parser 数组做运行时映射。不改变数据结构，不影响 `@opentui/core` 调用方。

**关键逻辑**:
```ts
const ONPREM = typeof process !== "undefined"
  ? process.env.OPENCODE_ONPREM_DIR
  : undefined

function localize(parsers: any[]) {
  if (!ONPREM) return parsers
  const base = `${ONPREM}/assets/tree-sitter`
  return parsers.map(p => ({
    ...p,
    wasm: `${base}/wasm/${p.wasm.split("/").pop()}`,
    queries: Object.fromEntries(
      Object.entries(p.queries).map(([k, urls]) => [
        k,
        (urls as string[]).map(u =>
          `${base}/queries/${p.filetype}/${u.split("/").pop()}`),
      ])
    ),
  }))
}
```

**映射规则**:
- `wasm` URL → `$ONPREM/assets/tree-sitter/wasm/<basename>`
- `queries` URL → `$ONPREM/assets/tree-sitter/queries/<filetype>/<basename>`
- 去重: 不做。每个 filetype 各自拷贝 query 文件（几 KB）

**向后兼容**: `OPENCODE_ONPREM_DIR` 未设置时行为完全不变。

---

### Patch 2: `packages/core/src/npm.ts`

**目的**: 
1. 新增 `findPackageDir()` 函数，优先从 onprem 预置目录查找已安装包
2. onprem 模式下，`add()` 未命中时阻断网络安装（作为离线总闸）

**方案**:

新增辅助函数:
```ts
const findPackageDir = (pkg: string): string | undefined => {
  const name = sanitize(pkg)
  const onpremBase = process.env.OPENCODE_ONPREM_DIR
  if (onpremBase) {
    const onpremDir = path.join(onpremBase, "assets", "npm", name)
    if (existsSync(path.join(onpremDir, "node_modules"))) return onpremDir
  }
  const cacheDir = path.join(global.cache, "packages", name)
  if (existsSync(path.join(cacheDir, "node_modules"))) return cacheDir
  return undefined
}

const isOnprem = !!process.env.OPENCODE_ONPREM_DIR
```

修改 `add()`:
```ts
const add = Effect.fn("Npm.add")(function* (pkg: string) {
  const name = ...
  const found = findPackageDir(pkg)
  if (found) {
    return resolveEntryPoint(name, path.join(found, "node_modules", name))
  }
  // onprem 模式：未预置的包直接拒绝，不触发网络安装
  if (isOnprem) {
    return yield* new InstallFailedError({ add: [pkg], dir: "" })
  }
  // 非 onprem：原有 reify 逻辑
  const dir = directory(pkg)
  if (yield* afs.existsSafe(path.join(dir, "node_modules", name))) {
    return resolveEntryPoint(name, path.join(dir, "node_modules", name))
  }
  const tree = yield* reify({ dir, add: [pkg] })
  ...
})
```

修改 `which()`:
```ts
const which = Effect.fn("Npm.which")(function* (pkg: string, bin?: string) {
  const found = findPackageDir(pkg)
  const dir = found ?? directory(pkg)
  const binDir = path.join(dir, "node_modules", ".bin")
  // ... 其余逻辑不变（pick 未命中会调 add，onprem 模式下 add 被阻断）
})
```

**查找优先级**: onprem (只读) → cache (用户可写) → undefined

**被此 patch 保护的所有路径**:
| 场景 | 原行为 | onprem 行为 |
|---|---|---|
| LSP `Npm.which()` × 10 | 未命中 → arborist 在线安装 | 命中则用，未命中 → 静默不可用 |
| Formatter `Npm.which()` × 3 | 未命中 → arborist 在线安装 | 同上 |
| Plugin `Npm.add()` | 在线安装 | 命中则用，未命中 → 报错 |
| Provider `Npm.add()` | 在线安装 | 命中则用，未命中 → 报错 |
| 用户 `opencode plug xxx` | 在线安装 | 查找失败（console 提示） |

---

## Bundle 目录结构

```
opencode-onprem-v1.18.7-linux-x64/
├── bin/                               # Linux/macOS: symlink → assets 中工具
│   │                                   # Windows:    shim.exe 副本 + .shim 配置
│   ├── opencode                      # CLI standalone binary (bun build --single)
│   ├── rg                            # symlink → ../assets/rg/rg
│   ├── rust-analyzer                 # symlink → ../assets/lsp/rust-analyzer
│   ├── clangd                        # symlink → ../assets/lsp/clangd/bin/clangd
│   ├── lua-language-server           # symlink → ../assets/lsp/lua-ls/bin/lua-language-server
│   ├── zls                           # symlink → ../assets/lsp/zls
│   ├── terraform-ls                  # symlink → ../assets/lsp/terraform-ls
│   ├── texlab                        # symlink → ../assets/lsp/texlab
│   ├── tinymist                      # symlink → ../assets/lsp/tinymist
│   ├── typescript-language-server    # symlink → ../assets/npm/typescript-language-server/node_modules/.bin/...
│   ├── vue-language-server           # symlink → ../assets/npm/@vue/language-server/node_modules/.bin/...
│   ├── pyright-langserver            # symlink → ../assets/npm/pyright/node_modules/.bin/...
│   ├── svelteserver                  # symlink → ../assets/npm/svelte-language-server/node_modules/.bin/...
│   ├── astro-ls                      # symlink → ../assets/npm/@astrojs/language-server/node_modules/.bin/...
│   ├── yaml-language-server          # symlink → ../assets/npm/yaml-language-server/node_modules/.bin/...
│   ├── bash-language-server          # symlink → ../assets/npm/bash-language-server/node_modules/.bin/...
│   ├── docker-langserver             # symlink → ../assets/npm/dockerfile-language-server-nodejs/node_modules/.bin/...
│   ├── intelephense                  # symlink → ../assets/npm/intelephense/node_modules/.bin/...
│   ├── biome                         # symlink → ../assets/npm/biome/node_modules/.bin/...
│   ├── prettier                      # symlink → ../assets/npm/prettier/node_modules/.bin/...
│   └── biome (formatter)             # symlink → ../assets/npm/@biomejs/biome/node_modules/.bin/...
│
├── desktop/                          # Electron unpacked (--dir 产物，解压即运行)
│   ├── opencode-desktop              # Desktop 可执行入口 (Linux)
│   │   (或 OpenCode Dev.app/         # macOS .app bundle)
│   │   (或 opencode-desktop.exe      # Windows)
│   ├── resources/
│   │   ├── app.asar                  # Electron 主进程 + renderer (含 opencode node bundle)
│   │   └── native/                   # 原生模块 (mac_window.node 等)
│   ├── locales/
│   └── ...                           # chrome-sandbox, crashpad handler 等
│
├── assets/
│   ├── tree-sitter/
│   │   ├── wasm/                     # 29 个 .wasm 文件
│   │   └── queries/
│   │       ├── python/               # highlights.scm, locals.scm
│   │       ├── rust/
│   │       └── ...（按 filetype 分目录）
│   │
│   ├── rg/
│   │   └── rg                        # ripgrep binary
│   │
│   ├── lsp/                          # GitHub Releases 类 LSP（需要目录结构的）
│   │   ├── rust-analyzer             # 单 binary
│   │   ├── clangd/                   # clangd_19.x/bin/clangd
│   │   ├── lua-ls/                   # bin/lua-language-server + meta/ + locale/
│   │   ├── zls
│   │   ├── terraform-ls
│   │   ├── texlab
│   │   └── tinymist
│   │
│   ├── shim.exe                       # ScoopInstaller/Shim (Windows 工具转发)
│   │
│   └── npm/                          # npm 包缓存
│       ├── typescript-language-server/
│       │   └── node_modules/...
│       ├── pyright/
│       │   └── node_modules/...
│       └── ...（12 个 npm 包 + plugins.json 中的额外插件）
│
├── env.sh
├── env.bat                          # Windows CMD 环境脚本
└── env.ps1                          # Windows PowerShell 环境脚本
```

---

## 预下载资源

### tree-sitter（29 种语言）

解析 `packages/tui/src/parsers-config.ts` 获取所有 wasm + query URL，下载到 `assets/tree-sitter/`:
- wasm: 约 29 个文件，单个 200KB-2MB
- queries: 约 50 个 .scm 文件，单个几 KB

### ripgrep

从 `https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/` 下载当前平台对应 binary。

### GitHub Releases LSP（7 个）

| Server | Binary | 下载方式 |
|---|---|---|
| rust-analyzer | 单文件 | GitHub Releases |
| clangd | tar.xz/zip → 解压 | GitHub Releases API → latest |
| zls | tar.xz/zip → 解压 | GitHub Releases API → latest |
| lua-language-server | tar.gz/zip → 解压保留整目录 | GitHub Releases API → latest |
| terraform-ls | zip → 解压 | HashiCorp Releases API → latest |
| texlab | tar.gz/zip → 解压 | GitHub Releases API → latest |
| tinymist | tar.gz/zip → 解压 | GitHub Releases API → latest |

### npm 包（12 个 LSP + Formatter）

| 包名 | 用途 |
|---|---|
| `typescript-language-server` | TS/JS LSP |
| `@vue/language-server` | Vue LSP |
| `pyright` | Python LSP |
| `svelte-language-server` | Svelte LSP |
| `@astrojs/language-server` | Astro LSP |
| `yaml-language-server` | YAML LSP |
| `bash-language-server` | Bash LSP |
| `dockerfile-language-server-nodejs` | Dockerfile LSP |
| `intelephense` | PHP LSP |
| `biome` | Biome LSP |
| `prettier` | 通用 Formatter |
| `@biomejs/biome` | Biome Formatter |

### 额外插件（来自 plugins.json）

```json
{
  "plugins": [
    "opencode-gemini-auth",
    "opencode-copilot-auth"
  ]
}
```

---

## `env.sh` / `env.bat` / `env.ps1` 设计

### Linux / macOS: `env.sh`

```bash
#!/usr/bin/env bash
export OPENCODE_ONPREM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$OPENCODE_ONPREM_DIR/bin:$PATH"
# 可选：将 desktop 可执行文件也加入 PATH
# export PATH="$OPENCODE_ONPREM_DIR/desktop:$PATH"

export OPENCODE_DISABLE_AUTOUPDATE=true
export OPENCODE_DISABLE_MODELS_FETCH=true
export OPENCODE_DISABLE_LSP_DOWNLOAD=true

echo "[opencode onprem] loaded from $OPENCODE_ONPREM_DIR"
```

用户只需 `source env.sh`，所有 ENV 和 PATH 即就绪。

### Windows: `env.bat` + `env.ps1`

Windows 上使用 [ScoopInstaller/Shim](https://github.com/ScoopInstaller/Shim) 方案替代 symlink。

**原理**：
- 构建时：`pack.ts` 为每个工具生成 `<tool>.shim` 配置文件 + 复制 `shim.exe` → `bin/<tool>.exe`
- `.shim` 格式：`path = "%OPENCODE_ONPREM_DIR%\assets\<tool-path>"`
- 运行时：用户运行 `bin/rg.exe` → shim 读取 `rg.shim` → 启动真实 `assets/rg/rg.exe`
- `OPENCODE_ONPREM_DIR` 由 env 脚本设置，保证 shim 能在任意解压位置工作

**CMD 用法**: `call env.bat`
**PowerShell 用法**: `. .\env.ps1`

env 脚本只需做两件事：
1. 设置 `OPENCODE_ONPREM_DIR` 为 bundle 根目录
2. `bin/` 加入 `PATH`
3. 设置 `OPENCODE_DISABLE_*` 环境变量

不再扫描 assets 子目录。所有工具通过 `bin/` 下的 shim 发现，PATH 保持干净。

**shim 来源**：`download.ts` 在 Windows 上自动从 [ScoopInstaller/Shim releases](https://github.com/ScoopInstaller/Shim/releases) 下载 C++ 版本（~155KB，零运行时依赖）。

---

## `download.ts` 设计

**位置**: `scripts/onprem/download.ts`

**接口**:
```bash
bun run scripts/onprem/download.ts \
  --platform linux|darwin|win32 \
  --arch x64|arm64 \
  --out ./assets                    # 输出目录
```

**流程**:
1. 动态 import `../../packages/tui/src/parsers-config`，提取所有 wasm + query URL
2. 并行下载 wasm → `<out>/tree-sitter/wasm/`
3. 并行下载 queries → `<out>/tree-sitter/queries/<filetype>/`
4. 下载 ripgrep → `<out>/rg/`
5. 下载 GitHub Releases LSP → `<out>/lsp/<name>/`
6. 逐个 npm 包：创建临时目录 → `bun add <pkg>` → 拷贝 `node_modules` → `<out>/npm/<pkg>/node_modules/`
7. 读取 `plugins.json`，对每个插件执行步骤 6
8. 输出下载统计

---

## `pack.ts` 设计

**位置**: `scripts/onprem/pack.ts`

**接口**:
```bash
bun run scripts/onprem/pack.ts \
  --platform linux|darwin|win32 \
  --arch x64|arm64
```

**流程**:
1. 检查 `git apply patches/*` 是否已应用
2. 读取 `manifest.json` 获取版本号，推导 bundle 目录名 `opencode-onprem-v<version>-<platform>-<arch>`
3. 创建 `dist/<bundle>/` 目录

   **阶段 A — CLI 构建**:
4. `cd packages/opencode && bun run build --single` → 编译 standalone binary
5. 复制编译产物 → `dist/<bundle>/bin/opencode`

   **阶段 B — Desktop 构建**:
6. `cd packages/opencode && bun script/build-node.ts` → 编译 opencode node bundle (`dist/node/node.js`)
7. `cd packages/app && bun run build` → 编译前端 SPA (`dist/`)
8. `cd packages/desktop`
   a. `OPENCODE_CHANNEL=dev bun run prebuild` → copy icons + metainfo, 构建 opencode node (复用步骤 6)
   b. `OPENCODE_CHANNEL=dev bun run build` → electron-vite 构建 main/preload/renderer
   c. `npx electron-builder --linux --dir --config electron-builder.config.ts` (或 --mac/--win)
      → `dist/linux-unpacked/` (或 `dist/mac/`、`dist/win-unpacked/`)
      - macOS: 设 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名/公证
      - Windows: `signWindows` 仅在 `GITHUB_ACTIONS=true` 时触发, 本地构建自动跳过
9. 复制 electron-builder --dir 产物 → `dist/<bundle>/desktop/`

   **阶段 C — 共享资源 + 打包**:
10. 调用 `download.ts --out ./dist/<bundle>/assets` → 预下载 wasm/queries/LSP/rg/npm
11. 创建 `bin/` 下工具入口:
    - Linux/macOS: 创建相对路径 soft links → `assets/` 中对应工具
    - Windows: 生成 Scoop-style shim — 每个工具 `bin/<tool>.exe`（shim.exe 副本）+ `<tool>.shim`（含 `%OPENCODE_ONPREM_DIR%` 路径）
12. 复制 `env.sh`（含 `OPENCODE_ONPREM_DIR`、`OPENCODE_DISABLE_*` 等）+ `env.bat` + `env.ps1` 到 bundle 根目录
13. 打包: Linux/macOS → `tar --zstd -cf ...`，Windows → `7z a -tzstd ...`
14. 输出 `opencode-onprem-v1.18.7-linux-x64.tar.zst`（Windows 为 `.7z`）

---

## 未覆盖的下载行为（无需处理）

| 行为 | 原因 |
|---|---|
| models.dev 获取 | `OPENCODE_DISABLE_MODELS_FETCH` 阻断 |
| 自动更新 | `OPENCODE_DISABLE_AUTOUPDATE` 阻断 |
| 内嵌 Web UI | 内嵌资源在构建时打包进 binary，离线可用 |
| go install (gopls) | onprem 模式下用户自行提供 go 环境 |
| gem install (rubocop) | onprem 模式下用户自行提供 ruby 环境 |
| dotnet tool install | onprem 模式下用户自行提供 dotnet 环境 |
| eslint/mix compile | 编译环境过于复杂，跳过 |
| provider 动态包 | 22 个内置 provider 已随 bundle 分发，自定义 provider 极罕见 |

---

## 不使用软链接的场景

- **不碰 `~/.cache/`**: 不在用户 home 目录创建任何文件或链接
- **bundle 内部只用相对路径软链接**: `bin/foo → ../assets/lsp/foo` 自包含，安全
- **npm 包加载不依赖软链接**: `findPackageDir()` 直接从 onprem 目录读，不影响 `~/.cache/opencode/packages/`

---

## Desktop 运行时说明

Desktop 版通过 Electron + Sidecar 架构运行，sidecar 是一个 `utilityProcess`，内部加载 opencode 的 Node.js bundle（`app.asar` 中）。

**启动方式**:

```bash
source env.sh
./desktop/opencode-desktop           # Linux
open ./desktop/OpenCode\ Dev.app     # macOS
./desktop/opencode-desktop.exe       # Windows
```

**assets 发现**: Desktop sidecar 继承 `source env.sh` 设置的环境变量（含 `OPENCODE_ONPREM_DIR`），因此能正常找到 bundle 内的 wasm/queries/LSP/npm 资源。**必须从终端 `source env.sh` 后启动**，直接双击可执行文件会因缺少 `OPENCODE_ONPREM_DIR` 而无法找到离线资源。

**不会触发的外部网络请求（运行时）**:

| 行为 | 状态 |
|---|---|
| 自动更新 (`electron-updater`) | 异步执行，失败静默忽略 |
| Sentry 错误上报 | DSN 在构建时注入，发送失败静默丢弃 |
| Desktop 通知图标 (`opencode.ai/favicon`) | 离线 404，不影响功能 |
| CLI Web UI (`localhost:4096`) | 内嵌资源从 bunfs 读取，离线可用 |

---

## 维护说明

升级到新 upstream 版本时：
1. `git am patches/*.patch` 或 `git apply patches/*.patch`
2. 如有冲突，手动解决后重新生成 patch
3. 如 npm 包版本更新，修改 `download.ts` 中的包列表
4. 如 parsers-config.ts 新增语言，`download.ts` 自动适配（动态 import）
5. 更新 `manifest.json` 中的版本号
