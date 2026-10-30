# BRC 统一 CLI

`@inoceanlee/brc` 用于在 Windows 原生环境手动管理 Relay、Traefik 和 Agent。

CLI 只管理由它启动的服务。CLI 不管理 Tailscale Funnel。

## 安装

正式发布后，在 PowerShell 或 CMD 中执行：

```powershell
pnpm add -g @inoceanlee/brc
```

首次使用时初始化配置并安装 Traefik：

```powershell
brc setup
brc start
```

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
首次 `brc setup` 会在新数据根初始化 Relay 数据库。已有数据根缺少数据库时，`setup` 会拒绝新建；`start` 与 `restart` 也会拒绝启动。Relay 遇到管理员身份缺失或孤立用户关联时会停止启动，并在迁移旧表前创建备份。

## 数据与卸载

默认数据目录为 `%LOCALAPPDATA%/BRC/`。设置 `BRC_DATA_ROOT` 可改用隔离数据目录。

完整卸载前，`brc uninstall` 会显示数据根并请求确认。非交互运行时必须传入 `--yes`。

命令先停止受管服务并清理 BRC 私有数据，再卸载全局包。Windows 会在 CLI 退出后完成卸包，并输出完成报告路径。

`pnpm remove -g @inoceanlee/brc` 只卸载软件包，不删除 BRC 数据。

Tailscale Funnel 仍由用户单独管理。
