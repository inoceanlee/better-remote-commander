# BRC 架构

## 运行形态

BRC 是面向 Windows x64 的单一 npm 包 `@inoceanlee/brc`。CLI 统一管理 Relay、Traefik 和 Agent。用户通过 pnpm 全局安装，使用 `brc setup` 初始化，再用 `brc start` 和 `brc stop` 管理进程。

公网 HTTPS 入口由用户管理，通常使用 Tailscale Funnel。入口将 HTTP、MCP 和 WebSocket 转发至 Windows 本机的 Traefik。Relay、Traefik 管理入口和 Agent 管理入口均绑定 loopback。BRC 不管理公网域名或 Funnel 生命周期。

```text
支持远程 MCP 的聊天客户端
             |
       公网 HTTPS 入口
             |
  Traefik (127.0.0.1)
             |
             v
  Relay (HTTP/MCP/OAuth)
             ^
             | 出站 WebSocket
             |
   Agent (24 种本机工具)
   管理端口仅限本机
```

## 代码结构

- `packages/cli/`：统一命令、配置校验、生命周期、代理运行及维护清理；发行版本的唯一来源是其 `package.json`。
- `packages/relay/`：HTTP 服务、用户及设备、SQLite、OAuth、MCP、审计记录。
- `packages/agent/`：配对和持久凭据、出站 WebSocket、文件和终端等工具。
- `packages/shared/`：通信协议、共同类型和受管控制接口。
- `native/brc-process/`：Windows x64 Rust 进程身份查询器。
- `deploy/traefik/`：统一代理的静态和动态配置模板。
- `scripts/`：构建、隔离测试、性能检查和手动 npm 发布流程。
- `tests/`：Node 单测、生命周期安全、原生组件与发行流程回归。

## 配置与身份

用户数据根默认为 `%LOCALAPPDATA%\BRC\`，可通过 `BRC_DATA_ROOT` 更改。唯一可编辑配置文件为 `config/brc.yaml`，使用 `brc config show/get/set/apply/path` 管理。默认值、类型和校验集中在 `packages/cli/src/config/settings.ts`。

Relay 使用 SQLite 保存管理员、OAuth 客户端、访问令牌和设备归属。正常重启、升级和配置应用保留这些身份。数据库缺失、归属不一致或管理员异常时，拒绝危险的自动重建；新建数据库由 `brc setup` 初始化。

Agent 向 Relay 主动建立 WebSocket 连接，经设备配对获取凭据。ChatGPT 等客户端通过 OAuth 授权访问 `/mcp`；Relay 对工具调用执行设备选择、鉴权和审计。Traefik 的全站限流及并发限制只是入口资源保护，不替代 Relay 身份认证。

## 生命周期与边界

启动顺序：Relay、Traefik、Agent。停止顺序相反。跨进程配置应用、启停和 Traefik 切换使用统一的原子目录锁。终止进程和恢复失效锁前必须核验 PID、启动时间、命令行及可执行路径；身份不完整时拒绝危险操作。

Traefik 使用单条公共路由共享限流和并发约束。服务只绑定 `127.0.0.1`。更新 Traefik 时，先下载并校验官方文件，再在生命周期锁内切换。常规清理不得删除 SQLite、凭据或来源不明的进程。

## 构建、测试和发布

开发需要 Node.js 22.13+、pnpm；Windows 原生构建还需要 Rust MSVC 工具链。根目录的 `pnpm build` 构建四个工作区包和 Windows 原生进程查询器。

验证入口为 `pnpm test:unit`、`pnpm test:e2e` 和 `pnpm test:package`。E2E 在独立临时数据库、凭据与随机 loopback 端口运行；设置 `BRC_TRAEFIK_TEST_BINARY` 可将官方 Traefik 纳入 E2E。测试不得影响当前运行的 BRC。

`pnpm release:brc` 使用 CLI 清单中的明确版本，生成 gzip 9 发行包、运行隔离测试并发布到 npm。只有注册表确认发布后才创建 `brc-v<version>` Git 标签。发布失败的恢复与发行包精简属于独立维护任务；GitHub CI 只验证源码，不自动发布。