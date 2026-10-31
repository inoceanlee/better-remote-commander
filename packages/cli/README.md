# BRC 统一 CLI

`@inoceanlee/brc` 用于在 Windows 原生环境手动管理 Relay、Traefik 和 Agent。

CLI 只管理由它启动的服务。CLI 不管理 Tailscale Funnel。

## 安装

正式发布后，在 PowerShell 或 CMD 中执行：

```powershell
pnpm add -g @inoceanlee/brc
```

首次使用时初始化配置、管理员身份并安装 Traefik：

```powershell
brc setup
brc start
```

首次执行 `brc setup` 会提示输入管理员用户名（默认 `admin`）与密码（输入时隐藏，至少 8 个字符）。密码仅以哈希形式保存在 Relay SQLite 数据库；会话密钥在首次初始化时生成并存入同一数据库。后续 `brc start` 和 `brc restart` 不再要求密码或会话密钥环境变量。非交互式首次初始化可以通过 `BRC_ADMIN_USER` 和 `BRC_ADMIN_PASSWORD` 环境变量传入一次性初始化值，启动服务不会继承这些变量。首次初始化完成后应清除临时环境变量。

Node.js 版本必须为 22.13 或更高。

## 常用命令

```text
brc status
brc logs [relay|agent|traefik]
brc config show
brc update traefik
brc stop
```

更新 CLI 包：

```powershell
pnpm up -g @inoceanlee/brc --latest
```

`brc start` 不会自动下载或升级 Traefik。只有 `brc setup` 和 `brc update traefik` 会检查官方稳定版。
首次 `brc setup` 会在新数据根初始化 Relay 数据库和管理员身份。已有数据根缺少数据库时，`setup` 会拒绝新建；`start` 与 `restart` 也会拒绝启动。Relay 遇到管理员身份、会话密钥缺失或孤立用户关联时会停止启动，并在迁移旧表前创建备份。

## 升级与回退

正式发布后，升级前记录已安装版本，并安全备份整个数据根。默认根目录为 `%LOCALAPPDATA%/BRC/`；自定义目录以 `BRC_DATA_ROOT` 为准。备份需包含 Relay 数据库及存在的 SQLite `-wal`、`-shm` 文件，并限制备份访问权限。

记录版本并执行 `brc stop` 后，使用本机现有的受控工具创建整个数据根的离线快照。确认快照包含数据库及 WAL/SHM 文件后，再运行 `pnpm up`。下方命令不会自动创建备份。

```powershell
pnpm list -g @inoceanlee/brc --depth 0
brc stop
pnpm up -g @inoceanlee/brc --latest
brc start
brc status
brc logs relay
```

CLI 包升级异常时，先停止服务，再安装升级前记录的版本：`pnpm add -g @inoceanlee/brc@<旧版本>`。只有确需恢复数据库时才还原升级前的完整数据库文件集；恢复会丢弃备份之后的写入。身份迁移失败会报告 `*.pre-identity-migration-*.bak` 备份路径；事务失败时原数据库保持不变。不要用 `--initialize` 替代恢复。

`brc update traefik` 在候选版本启动或健康检查失败时会自动恢复升级前版本。查看 `brc status` 和 `brc logs traefik` 确认状态。CLI 暂不提供成功升级后的手动历史版本选择命令。

## 数据与卸载

默认数据目录为 `%LOCALAPPDATA%/BRC/`。设置 `BRC_DATA_ROOT` 可改用隔离数据目录。

完整卸载前，`brc uninstall` 会显示数据根并请求确认。非交互运行时必须传入 `--yes`。

命令先停止受管服务并清理 BRC 私有数据，再卸载全局包。Windows 会在 CLI 退出后完成卸包，并输出完成报告路径。

`pnpm remove -g @inoceanlee/brc` 只卸载软件包，不删除 BRC 数据。

Tailscale Funnel 仍由用户单独管理。

## 本地验收记录

2026-10-31 的验收使用临时数据库、随机 loopback 端口和官方 Traefik 二进制。构建通过；单元测试 112/112 通过；E2E 全部通过。隔离包更新前后 Relay `users.id` 保持不变。经 Traefik 验证 OAuth、多客户端设备一致性、Agent WebSocket 重连、2.5 秒 MCP 请求和 256 KiB 响应。此记录不代表 npm 发布或公网切换。
