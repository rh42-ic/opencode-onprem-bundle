# opencode-onprem-bundle

将 [opencode](https://github.com/anomalyco/opencode) 打包为自包含的离线 bundle，包含 CLI 版本。

用户在 air-gap 环境中 `source env.sh` 即可使用，无需任何网络访问。

## 快速开始

```bash
# 1. 解压 bundle
tar --zstd -xf opencode-onprem-v1.18.14-linux-x64.tar.zst
cd opencode-onprem-v1.18.14-linux-x64/

# 2. 加载环境
source env.sh

# 3. 运行
opencode --version
```

## Bundle 结构

```
opencode-onprem-v1.18.14-linux-x64/
├── bin/                              # 可执行文件
│   ├── opencode                      # CLI standalone binary
│   ├── rg                            # ripgrep
│   ├── rust-analyzer                 # Rust LSP
│   ├── clangd                        # C/C++ LSP
│   ├── zls                           # Zig LSP
│   ├── lua-language-server           # Lua LSP
│   ├── terraform-ls                  # Terraform LSP
│   ├── texlab                        # LaTeX LSP
│   ├── tinymist                      # Typst LSP
│   ├── typescript-language-server    # TS/JS LSP
│   ├── vue-language-server           # Vue LSP
│   ├── pyright-langserver            # Python LSP
│   ├── svelteserver                  # Svelte LSP
│   ├── astro-ls                      # Astro LSP
│   ├── yaml-language-server          # YAML LSP
│   ├── bash-language-server          # Bash LSP
│   ├── docker-langserver             # Dockerfile LSP
│   ├── intelephense                  # PHP LSP
│   ├── biome                         # Biome (LSP + Formatter)
│   └── prettier                      # Formatter
├── assets/
│   ├── tree-sitter/                  # 语法高亮 (31 种语言)
│   │   ├── wasm/                     # .wasm 解析器
│   │   └── queries/                  # .scm 查询文件
│   ├── rg/                           # ripgrep binary
│   ├── lsp/                          # GitHub Releases LSP
│   ├── eslint/                       # vscode-eslint LSP (构建机预编译, 原版行为)
│   │   └── vscode-eslint/            #   main.zip → npm install → npm run compile
│   ├── npm/                          # npm 包缓存 (13 个, 含 eslint 本体)
│   └── models/                       # models.dev catalog (离线 model 配置)
│       └── models.json
├── env.sh                            # 环境配置脚本
└── README.md
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `OPENCODE_ONPREM_DIR` | bundle 根目录路径（env.sh 自动设置） |
| `OPENCODE_DISABLE_AUTOUPDATE` | 禁用自动更新检查 |
| `OPENCODE_DISABLE_MODELS_FETCH` | 禁用模型列表远程获取 |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | 禁用 LSP 自动下载 |
| `OPENCODE_MODELS_PATH` | 预下载的 models catalog JSON 文件路径（自动指向 assets/models/models.json） |

## 构建 bundle

```bash
# 推荐：在 upstream 根目录运行
cd opencode-1.18.14/

# 步骤 1: 应用补丁
git apply ../opencode-onprem-bundle/patches/001-parsers-config.patch
git apply ../opencode-onprem-bundle/patches/002-npm-onprem-gate.patch
git apply ../opencode-onprem-bundle/patches/003-file-type-deps.patch

# 步骤 2: 复制脚本到 upstream（download.ts 通过 __dirname 读取同目录的 plugins.json，必须放一起）
mkdir -p scripts/onprem
cp ../opencode-onprem-bundle/scripts/download.ts scripts/onprem/
cp ../opencode-onprem-bundle/scripts/pack.ts scripts/onprem/
cp ../opencode-onprem-bundle/scripts/env.sh scripts/onprem/
cp ../opencode-onprem-bundle/scripts/env.bat scripts/onprem/
cp ../opencode-onprem-bundle/scripts/env.ps1 scripts/onprem/
cp ../opencode-onprem-bundle/manifest.json scripts/onprem/
cp ../opencode-onprem-bundle/plugins.json scripts/onprem/

# 步骤 3: 运行打包（pack.ts 从 manifest.json 读取版本号，需与 OPENCODE_VERSION 一致）
bun run scripts/onprem/pack.ts --platform linux --arch x64
```

## 未捆绑的工具

以下工具需用户在 air-gap 环境中自行提供：

| 工具 | 语言 | 原因 |
|---|---|---|
| gopls | Go | 需完整 Go 工具链 |
| rubocop | Ruby | 需完整 Ruby 环境 |
| csharp-ls | C# | 需 .NET SDK |
| mix compile | Elixir | 需完整 Elixir 环境 |

## License

MIT — 与 upstream opencode 保持一致。
