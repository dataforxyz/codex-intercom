# Codex Intercom

Codex MCP plugin for direct local messaging with Pi and Codex coding-agent
sessions on the same machine.

Codex Intercom speaks the same local broker protocol as `pi-intercom`, so Codex
sessions can list Pi sessions, send direct messages, ask blocking questions,
check pending inbound messages, and reply to pending asks.

## Status

Preview. This is the Codex-side adapter split out of `pi-intercom`.

Codex MCP does not currently provide Pi-style unsolicited turn wake-up. Incoming
messages are queued while this MCP server is running; call `intercom_pending`
to read unread messages and unresolved asks.

## Tools

- `intercom_whoami`
- `intercom_status`
- `intercom_list`
- `intercom_set_summary`
- `intercom_send`
- `intercom_ask`
- `intercom_pending`
- `intercom_reply`

## Local Setup

```bash
git clone https://github.com/dataforxyz/codex-intercom.git
cd codex-intercom
npm install
codex mcp add codex-intercom -- npx --no-install tsx ./codex/server.ts
```

Optional identity variables:

```bash
CODEX_INTERCOM_NAME=planner
CODEX_INTERCOM_SESSION_ID=codex-planner
CODEX_INTERCOM_MODEL=codex
```

## Codex Plugin

This repo includes Codex plugin metadata:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/codex-intercom/SKILL.md`

The plugin runs the MCP server with:

```bash
npx --no-install tsx ./codex/server.ts
```

That means a local checkout currently needs `npm install` before Codex starts
the MCP server. A later package build can ship compiled JavaScript or a bin
entrypoint.

## Examples

List sessions:

```typescript
intercom_list({ scope: "machine" })
```

Send a non-blocking update:

```typescript
intercom_send({
  to: "worker",
  message: "I found the failing test. Check src/api/client.test.ts."
})
```

Ask and wait:

```typescript
intercom_ask({
  to: "planner",
  message: "Should retry apply only to idempotent endpoints?"
})
```

Check and reply:

```typescript
intercom_pending({ mark_read: false })
intercom_reply({ message: "Use GET/PUT/DELETE only, max 3 retries." })
```

## Relationship To Pi Intercom

`pi-intercom` remains the Pi-native extension with overlays, inline rendering,
and Pi `triggerTurn` delivery. `codex-intercom` is the Codex MCP/plugin
adapter.

For now this repository vendors the minimal local broker/client protocol for
compatibility. If the protocol stabilizes across multiple adapters, the shared
parts should move into a small core package.

## Test

```bash
npm test
```
