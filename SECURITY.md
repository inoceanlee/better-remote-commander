# Security

## Trust boundaries

BRC runs Agent tools with the privileges of the Windows account that starts it. An authorized remote MCP client can run terminal commands and access files within the Agent's configured restrictions. Only grant access to clients you trust.

- The public HTTPS entry point is managed separately, for example with Tailscale Funnel.
- Forward public traffic to the local Traefik proxy. Relay and management endpoints must remain bound to `127.0.0.1`.
- Traefik provides rate and concurrency protection. Relay handles OAuth, device pairing, token checks and tool authorization.
- The Agent establishes an outbound WebSocket connection and does not expose a public listener.
- SQLite, OAuth credentials and device pairing data live in the private BRC data root. Protect this directory and keep it out of source control.

## Operating guidance

1. Install the unified package and initialize identity with `brc setup`.
2. Set `services.publicUrl` to the actual HTTPS origin and verify the proxy forwards WebSocket and MCP requests.
3. Use `brc status` and `brc logs` to inspect the three managed services.
4. Review paired devices in Relay's dashboard. Revoke access for devices or OAuth clients that should no longer connect.
5. Keep the public entry point, BRC package and Traefik current through their separate update processes.

Treat unexpected tool activity, missing identity data and database integrity errors as security events. BRC deliberately refuses unsafe automatic identity recovery or broad process termination.

## Reporting

Report security issues privately to the repository maintainer, including the affected component, current package version and a minimal reproduction without tokens, passwords or private data. The package version is defined in `packages/cli/package.json`.
