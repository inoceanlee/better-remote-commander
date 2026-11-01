# Better Remote Commander (BRC)

Use your existing AI chat access to work on your own computer. BRC connects chat clients that support remote MCP (Model Context Protocol) to a self-hosted relay. You can manage files, run terminal commands, and inspect processes from a conversation.

Free chat allowances, such as ChatGPT's free tier, and chat allowances separate from coding-agent quotas, such as those in the Gemini ecosystem, are useful resources. BRC can put compatible chat access to work when the client supports remote MCP tools. Connector access depends on the platform and plan.

Based on [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander).

## Requirements

- Windows x64 (tested on Windows 11).
- Node.js 22.13 or newer and pnpm.
- An HTTPS endpoint reachable by your chat client for remote access. Connect your public entry point to the local Traefik proxy.

BRC runs Relay, Traefik, and Agent locally. You manage the public HTTPS entry point separately.

## Installation

Run these commands in PowerShell, in order.

**1. Install BRC with pnpm.**

```powershell
pnpm add -g @inoceanlee/brc
```

**2. Initialize BRC.**

```powershell
brc setup
```

Enter the administrator username (default: `admin`) and a password of at least eight characters. Setup creates the local configuration and installs Traefik.

**3. Set the public URL** for remote MCP access.

```powershell
brc config set services.publicUrl https://your-domain.example
```

Point your HTTPS entry point to the local Traefik proxy at `127.0.0.1:13001`. The URL must be the origin, without `/mcp`.

**4. Start BRC and check its status.**

```powershell
brc start
brc status
```

On the first start, pair the Agent using the code and device verification page shown in its output or `brc logs agent`. Then add `https://your-domain.example/mcp` as a remote MCP server in a compatible chat client, such as ChatGPT or Claude, when supported by your plan.

## Common commands

| Command | Purpose |
| --- | --- |
| `brc help` | Show commands |
| `brc start` | Start Relay, Traefik, and Agent |
| `brc stop` | Stop all managed services |
| `brc restart` | Restart managed services |
| `brc status` | Check service status |
| `brc logs [relay\|agent\|traefik]` | Read service logs |
| `brc config show` | Show effective settings |
| `brc config get <key>` | Read a setting |
| `brc config set <key> <value>` | Change a setting |
| `brc config apply` | Apply changes made to the YAML file |
| `brc config path` | Show the configuration file path |
| `brc update traefik` | Update Traefik |
| `brc clean` | Clean temporary runtime data |

To upgrade the BRC package, run `pnpm up -g @inoceanlee/brc --latest`.

## Configuration and data

BRC stores its configuration and runtime data under `%LOCALAPPDATA%\BRC\` on Windows.

- Configuration: `%LOCALAPPDATA%\BRC\config\brc.yaml`
- Data, Traefik files, runtime state, and logs: subdirectories of `%LOCALAPPDATA%\BRC\`

Set `BRC_DATA_ROOT` to use a different root directory. Run `brc config path` or `brc config show` to find the file and inspect current settings.

## Uninstallation

Run these steps in order.

**1. Uninstall BRC's services and private data.**

```powershell
brc uninstall
```

Confirm the displayed data directory when prompted. This stops the managed services and removes BRC configuration, credentials, database, Traefik files, logs, and other data in its private directory.

**2. Remove any remaining global pnpm package.**

```powershell
pnpm remove -g @inoceanlee/brc
```

`brc uninstall` currently also schedules pnpm package removal automatically after the CLI exits on Windows. Wait for that removal to finish before running the second command; it is normally already complete.

To remove the package while keeping BRC's stored data, run only `pnpm remove -g @inoceanlee/brc`. The public HTTPS entry point, such as Tailscale Funnel, remains under your separate management.

## Development and contributing

```powershell
git clone https://github.com/inoceanlee/better-remote-commander.git
cd better-remote-commander
pnpm install
pnpm build
pnpm test
```

Issues and pull requests are welcome in this repository. The source uses pnpm workspaces with separate CLI, Relay, Agent, and shared packages. See [architecture](https://github.com/inoceanlee/better-remote-commander/blob/main/docs/architecture.md) for implementation details.

Security guidance: [SECURITY.md](SECURITY.md). MIT license: [LICENSE](LICENSE). Tool attribution: [NOTICE](NOTICE).
