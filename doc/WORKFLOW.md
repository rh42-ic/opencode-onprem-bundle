# Workflow 设计

## 原则

### Matrix 构建

使用 GitHub Actions matrix strategy，`ubuntu-latest` / `windows-latest` 两个 runner 并行构建，每个平台产出各自的 bundle。

原因：

- Desktop 构建（electron-builder）必须原生运行，无法跨平台交叉编译
- 两类 runner GitHub 免费提供，并行执行互不阻塞
- 矩阵结构只需一份步骤定义，维护成本低

### vars → build → release 三阶段

```
vars (ubuntu)           ← 轻量，仅解析版本号
  │
  ├── build (linux)     ← ubuntu-latest，产出 .tar.zst
  └── build (win32)     ← windows-latest，产出 .7z
  │
release (ubuntu)        ← 汇总全部 artifact，一次性发布
```

### 脚本自包含

`pack.ts`、`download.ts` 所需的 `manifest.json`、`plugins.json`、`env.sh`、`env.bat`、`env.ps1` 都放在自身旁边（`__dirname` 下的文件），不引用外部目录。

CI 负责把 opencode-onprem-bundle 中的 patches 应用到 upstream 源码，然后把 scripts/ + manifest.json + plugins.json + env.* 复制进 `upstream/scripts/onprem/`。

### patches 由 CI 应用

`git apply` 在 workflow 中完成，pack.ts 只在 patches 未应用时报错退出作为防御。

### 平台差异

| | Linux | Windows |
|---|---|---|
| **Runner** | ubuntu-latest | windows-latest |
| **系统依赖** | apt: libgtk-3-dev, zstd... | choco: 7zip |
| **打包格式** | tar.zst | 7z (zstd) |
| **bin/ 工具发现** | symlink | Scoop-style shim (shim.exe + .shim config) |
| **env 脚本** | env.sh | env.bat + env.ps1 |

### Windows 的 bin/ 策略

Windows 上使用 [ScoopInstaller/Shim](https://github.com/ScoopInstaller/Shim) 方案：

- `bin/` 中每个工具都是一个 `shim.exe` 的副本（重命名为 `<tool>.exe`）
- 配对的 `<tool>.shim` 配置文件指定真实可执行文件路径：`path = "%OPENCODE_ONPREM_DIR%\assets\lsp\..."`
- 用户只需把 `bin/` 加入 `PATH`（由 env.bat/env.ps1 完成）
- shim.exe 是原生 C++ 程序，~155KB，零运行时依赖，启动开销 ~86ms

## 流程

```
GitHub Actions Matrix
 │
 ├─ vars (ubuntu-latest)
 │   └─ 解析 tag / workflow_dispatch 输入 → upstream_ver, tag_name
 │
 ├─ build (ubuntu-latest) ── linux-x64
 │   ├─ checkout opencode-onprem-bundle
 │   ├─ 下载 upstream → workspace/upstream/
 │   ├─ git apply patches → upstream
 │   ├─ 复制 scripts + manifest + plugins + env.* → upstream/scripts/onprem/
 │   ├─ apt install libgtk-3-dev zstd ...
 │   ├─ bun install
 │   ├─ bun run pack.ts --platform linux --arch x64
 │   │   ├─ CLI standalone binary
 │   │   ├─ electron Desktop
 │   │   ├─ tree-sitter / ripgrep / LSP / npm
 │   │   └─ tar --zstd 打包
 │   └─ upload-artifact (bundle-linux-x64)
 │
 ├─ build (windows-latest) ── win32-x64
 │   ├─ checkout opencode-onprem-bundle
 │   ├─ 下载 upstream
 │   ├─ git apply patches
 │   ├─ 复制 scripts + ...
 │   ├─ choco install 7zip
 │   ├─ bun install
 │   ├─ bun run pack.ts --platform win32 --arch x64
 │   │   ├─ CLI standalone binary (opencode.exe)
 │   │   ├─ electron Desktop (--win --dir)
 │   │   ├─ tree-sitter / ripgrep / LSP / npm / shim.exe
 │   │   └─ 7z a -tzstd 打包
 │   └─ upload-artifact (bundle-win32-x64)
 │
 └─ release (ubuntu-latest)
     ├─ download-artifact (merge-multiple)
     └─ GitHub Release (3 个附件)
```
