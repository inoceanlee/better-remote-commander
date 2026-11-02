# Better Remote Commander (BRC)

[English](README.md) | 简体中文

通过你现有的 AI 对话客户端（如 ChatGPT、Claude 等），安全调度本地 Windows 电脑。BRC 将支持远程 MCP（Model Context Protocol）的客户端连接到本地自建的中继服务，让你在日常对话中管理文件、运行终端命令并查看系统状态。

本项目基于 [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander) 重写，专为 Windows x64 原生环境优化。

## 核心设计

- **单包极简管理**：单个 `@inoceanlee/brc` 包内置 Relay、Agent、Traefik 反向代理与 Rust 原生工具，一键全局安装。
- **免常驻守护与无容器**：纯用户态运行，统一按需手动启停，不注册系统服务，不强制 Docker。
- **Traefik 边缘流控**：内置 Traefik 反向代理，统筹单路限流、熔断与高并发保护；敏感管理端点严格绑定本地回环（loopback）。
- **进程身份自愈与目录锁**：采用 Rust 原生查询 Windows 进程启动时间与路径，杜绝误杀 `node.exe`；跨进程目录锁保障启停安全，自动识别系统 PID 复用并自愈陈旧失效锁。
- **单一配置源**：统一由 `config/brc.yaml` 集中管理，配置校验、环境覆盖与原子回滚相互解耦。

## 环境要求

- 操作系统：Windows x64（在 Windows 11 上完整测试）。
- 运行环境：Node.js 22.13 或更高版本。
- 包管理器：`pnpm` 或 `npm`。
- 公网接入：客户端远程访问所需的 HTTPS 入口。

> **关于公网入口**：公网接入层由用户自行管理，请将你的公网 HTTPS 流量转发到本地 Traefik 代理（默认监听 `127.0.0.1:13001`）。常见方案包括 Tailscale Funnel、Cloudflare Tunnel 等。如不熟悉公网配置，可直接咨询 AI 获取对应工具的安装与映射命令。

## 快速上手

请在 PowerShell 中按顺序执行以下命令：

**1. 全局安装 BRC**

使用 pnpm：
```powershell
pnpm add -g @inoceanlee/brc
```
或使用 npm：
```powershell
npm install -g @inoceanlee/brc
```

**2. 初始化系统**

```powershell
brc setup
```
按提示输入管理员账号（默认 `admin`）及密码（至少 8 位）。安装向导会自动创建本地配置并准备 Traefik。

**3. 设置公网源地址**

```powershell
brc config set services.publicUrl https://your-domain.example
```
> **注意**：填写完整的源地址（Origin），不要带 `/mcp` 路径。

**4. 启动并核验状态**

```powershell
brc start
brc status
```
首次启动时，终端或 `brc logs agent` 会显示设备配对码与验证页面。在浏览器完成配对后，即可在支持远程 MCP 的客户端中添加服务器地址：`https://your-domain.example/mcp`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `brc help` | 查看帮助与所有命令 |
| `brc start` | 依次启动 Relay、Traefik 和 Agent |
| `brc stop` | 停止所有受管服务 |
| `brc restart` | 重启所有受管服务 |
| `brc status` | 查看各服务运行与健康状态 |
| `brc logs [relay\|agent\|traefik]` | 查看指定服务运行日志 |
| `brc config show` | 查看当前生效配置 |
| `brc config get <key>` | 读取指定配置项 |
| `brc config set <key> <value>` | 修改配置项并原子保存 |
| `brc config apply` | 应用手动编辑后的 YAML 配置文件 |
| `brc config path` | 显示配置文件存放路径 |
| `brc update traefik` | 检查并更新 Traefik 组件 |
| `brc clean` | 清理临时运行时数据与无效锁 |

更新 BRC 版本：
```powershell
pnpm up -g @inoceanlee/brc --latest
# 或
npm update -g @inoceanlee/brc
```

## 配置与数据存储

BRC 的配置文件与私有数据默认存放于 `%LOCALAPPDATA%\BRC\`：

- 配置文件：`%LOCALAPPDATA%\BRC\config\brc.yaml`
- 数据库、凭据、Traefik 运行文件、运行时状态与日志：位于 `%LOCALAPPDATA%\BRC\` 各子目录

如需自定义存储位置，可设置环境变量 `BRC_DATA_ROOT`。执行 `brc config path` 可快速定位配置文件。

## 卸载指引

请根据是否保留配置与历史数据选择对应的卸载方式：

- **保留配置与私有数据（仅卸载 CLI 工具）**：
  直接移除全局包，所有数据库、配对信息和配置均完好保存：
  ```powershell
  pnpm remove -g @inoceanlee/brc
  # 或 npm rm -g @inoceanlee/brc
  ```
- **彻底卸载（同时删除私有数据与配置）**：
  运行卸载命令，按提示确认后，将自动停止所有服务，并彻底删除包括数据库、设备配对凭据、配置文件和日志在内的全部私有数据：
  ```powershell
  brc uninstall
  ```
  *注：`brc uninstall` 在退出后会自动触发全局包移除；若全局命令仍有残留，手动补跑一次包管理器的卸载命令即可。*

## 开发与贡献

```powershell
git clone https://github.com/inoceanlee/better-remote-commander.git
cd better-remote-commander
pnpm install
pnpm build
pnpm test
```

架构设计与内部模块细节详见 [架构设计文档](docs/architecture.md)。

## 许可协议与安全

安全规范参见 [SECURITY.md](SECURITY.md)，开源协议参见 [LICENSE](LICENSE)，第三方工具归属详见 [NOTICE](NOTICE)。
