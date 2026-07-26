# Workflow 设计

## 原则

### 单 job 串行

编译和打包在同一个 job 里串行完成。原因：

- 安装依赖、下载资源这些步骤是所有平台共享的，拆成多个 job 放大了重复开销
- 产出物集中在一个 runner 上，不需要 artifact 传递
- 没有跨平台兼容问题，没有 runner 排队问题

### 只跑 ubuntu

全部在 `ubuntu-latest` 上构建。macOS / Windows 的 CLI binary 可以通过 bun 交叉编译产出（待上游 build 脚本配置 `--target`），Desktop 同理可以用 electron-builder 的跨平台参数。

当前只构建 `linux-x64`，其他平台加入只需要在 workflow 里多写一行 `bun run pack.ts --platform X --arch Y`。

### 脚本自包含

`pack.ts`、`download.ts` 所需的 `manifest.json`、`plugins.json`、`env.sh` 都放在自身旁边（`__dirname` 下的文件），不引用外部目录。

CI 负责把 opencode-onprem-bundle 中的 patches 应用到 upstream 源码，然后把 scripts/ + manifest.json + plugins.json + env.sh 复制进 `upstream/scripts/onprem/`。复制完成后，opencode-onprem-bundle 仓库的使命就结束了——删掉也不影响构建。

### patches 由 CI 应用

`git apply` 在 workflow 中完成，pack.ts 不再自行应用 patches。pack.ts 只在 patches 未应用时报错退出作为防御。

## 流程

```
ubuntu-latest
 │
 ├─ checkout opencode-onprem-bundle
 ├─ 下载 upstream → workspace/upstream/
 ├─ git apply patches → upstream
 ├─ 复制 scripts + manifest + plugins + env → upstream/scripts/onprem/
 ├─ install 系统依赖
 ├─ bun install 上游依赖
 ├─ bun run pack.ts --platform linux --arch x64
 │   ├─ CLI standalone binary
 │   ├─ electron Desktop
 │   ├─ tree-sitter / ripgrep / LSP / npm
 │   └─ tar --zstd 打包
 └─ GitHub Release
```
