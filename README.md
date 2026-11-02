# Better Remote Commander (BRC)

English | [简体中文](README_zh.md)

BRC helps you make full use of chat allowances across AI providers—such as ChatGPT's free tier, or Gemini's separate chat and coding quotas—to safely control your local Windows PC from a chat window. This brings agent capabilities close to a local harness directly into everyday conversations, including file management, terminal command execution, and system status monitoring.

Based on [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander), rewritten and optimized for the native Windows x64 environment.

## Key Design

- **Single Package Management**: A single `@inoceanlee/brc` package bundles Relay, Agent, the Traefik reverse proxy, and native Rust utilities. One-command global installation.
- **Lightweight and Clean**: Unified manual start and stop on demand. Does not register Windows system services. You can set up scheduled or automated startup with AI guidance if needed.
- **Traefik Network Security**: Built-in Traefik reverse proxy coordinates single-route rate limiting, circuit breaking, and high-concurrency protection, adding lightweight network security for local services.
- **Single Source of Truth**: All configuration settings are managed centrally in `config/brc.yaml`.

## Requirements

- Operating system: Windows 11 x64.
- Runtime environment: Node.js.
- Package manager: `pnpm` or `npm`.
- Public access: An HTTPS endpoint for remote client connections.

> **About Public Ingress**: You manage the public HTTPS entry point. Forward your public HTTPS traffic to the local Traefik proxy (listens on `127.0.0.1:13001` by default). Common solutions include Tailscale Funnel and Cloudflare Tunnel. If you are unfamiliar with ingress configuration, ask your AI for installation and setup instructions.

## Installation and Quick Start

Run these commands in PowerShell in order:

**1. Install BRC globally**

With pnpm:

```powershell
pnpm add -g @inoceanlee/brc
```

Or with npm:

```powershell
npm install -g @inoceanlee/brc
```

**2. Initialize the system**

```powershell
brc setup
```

Enter the administrator username (default: `admin`) and a password with at least 8 characters. The setup wizard generates local configuration files and prepares Traefik.

**3. Set the public URL**

```powershell
brc config set services.publicUrl https://your-domain.example
```

> **Note**: Enter the full origin URL without the `/mcp` path.

**4. Start services and check status**

```powershell
brc start
brc status
```

On first start, the terminal or `brc logs agent` outputs a device pairing code and verification page URL. Complete pairing in your browser, then add the server address `https://your-domain.example/mcp` to your remote MCP-compatible AI chat client.

## Common Commands

| Command | Purpose |
| --- | --- |
| `brc help` | Show help and all commands |
| `brc start` | Start Relay, Traefik, and Agent in sequence |
| `brc stop` | Stop all managed services |
| `brc restart` | Restart all managed services |
| `brc status` | Check service health and running status |
| `brc logs [relay\|agent\|traefik]` | View service logs |
| `brc config show` | View effective configuration |
| `brc config get <key>` | Read a specific configuration setting |
| `brc config set <key> <value>` | Update a setting and save atomically |
| `brc config apply` | Apply manually edited YAML configuration |
| `brc config path` | Display configuration file path |
| `brc update traefik` | Check and update Traefik binary |
| `brc clean` | Clean temporary runtime data and invalid locks |

Update BRC to the latest version:

```powershell
pnpm up -g @inoceanlee/brc --latest
# or
npm update -g @inoceanlee/brc
```

## Configuration and Data Storage

BRC stores configuration and private data in `%LOCALAPPDATA%\BRC\`:
Set the `BRC_DATA_ROOT` environment variable to use a custom directory.
Run `brc config path` to locate the configuration file.

## Uninstallation

Choose the uninstallation method based on whether you want to preserve your data:

- **Keep configuration and private data (uninstall CLI only)**:
  Remove the global package directly. Database records, pairing credentials, and configuration files stay intact:
  ```powershell
  pnpm remove -g @inoceanlee/brc
  # or npm rm -g @inoceanlee/brc
  ```
- **Complete uninstallation (delete private data and configuration)**:
  Run the uninstall command and confirm the prompt. This stops all services and permanently removes all private data, including databases, pairing credentials, configuration files, and logs:
  ```powershell
  brc uninstall
  ```
  *Note: `brc uninstall` automatically schedules package removal upon exit. If the global command persists, run the package manager uninstall command manually.*

## License and Security

See [SECURITY.md](SECURITY.md) for security guidelines, [LICENSE](LICENSE) for the open-source license, and [NOTICE](NOTICE) for third-party attributions.

—— 20261102
