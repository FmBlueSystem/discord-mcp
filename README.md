# discord-mcp

Discord MCP Server for OpenCode — Read Discord channels directly from your AI agent.

Uses Discord REST API v10 with user token authentication. **No bot required, no server admin needed.**

## Features

- **7 MCP Tools**: List guilds, list channels, read messages, search messages, get pinned, get channel info, get specific message
- **REST API Mode**: No discord.js, no WebSocket gateway — 1 dependency only (`@modelcontextprotocol/sdk`)
- **User Token Auth**: Works on any server your Discord account has access to (no admin required)
- **Search**: Full-text search across channel message history
- **Pagination**: Read unlimited history with before/after cursors

## Quick Start

### 1. Install

```bash
mkdir -p ~/.config/opencode/plugins/discord-mcp
cd ~/.config/opencode/plugins/discord-mcp
npm init -y
npm install @modelcontextprotocol/sdk
```

Copy `assets/index.mjs` to the project root (or use it directly):

```bash
cp assets/index.mjs index.mjs
```

### 2. Get your Discord token

#### Option A: User Token (no admin needed)

Use Playwright to capture your token from a browser session:

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(user_agent="Mozilla/5.0 ...")
    page = context.new_page()

    page.goto("https://discord.com/login")
    page.locator('input[name="email"]').fill("your@email.com")
    page.locator('input[name="password"]').fill("your_password")
    page.locator('button[type="submit"]').click()

    user_token = [None]
    def on_response(response):
        auth = response.request.headers.get('authorization', '')
        if auth and not auth.startswith('Bot') and len(auth) > 50:
            user_token[0] = auth
    context.on("response", on_response)

    page.goto("https://discord.com/channels/@me")
    # Wait for token capture...
```

#### Option B: Bot Token (requires server admin)

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create New Application → Bot → Copy Token
3. Enable Privileged Gateway Intents: Presence, Server Members, Message Content
4. Invite bot with `bot` scope and `66560` permissions

### 3. Configure in opencode.json

```json
{
  "mcp": {
    "discord": {
      "type": "local",
      "command": ["node", "/path/to/discord-mcp/index.mjs"],
      "environment": {
        "DISCORD_USER_TOKEN": "your_token_here"
      }
    }
  }
}
```

For bot mode, use `DISCORD_BOT_TOKEN` instead.

### 4. Restart OpenCode

The MCP server starts automatically. Use any of the 7 tools:

| Tool | Description |
|------|-------------|
| `discord_list_guilds` | List all servers you have access to |
| `discord_list_channels` | List all channels in a server |
| `discord_read_channel` | Read messages from a channel |
| `discord_search_messages` | Search messages by text |
| `discord_get_channel_info` | Get channel metadata |
| `discord_get_pinned` | Get pinned messages |
| `discord_get_message` | Get a specific message by ID |

## Usage Examples

Ask your AI agent:

- "List all my Discord servers"
- "Read the last 20 messages from the #general channel in Gentleman Programming"
- "Search for messages about 'plugins' in #gentle-ai"
- "Show me the pinned messages in #anuncios"

## Architecture

```
┌─────────────┐     MCP/stdio       ┌──────────────────┐     REST API       ┌──────────┐
│  OpenCode    │ ◄────────────────► │  discord-mcp      │ ◄────────────────►│  Discord  │
│  (AI Agent)  │   JSON-RPC          │  index.mjs        │   v10 Bearer      │  Servers  │
└─────────────┘                      └──────────────────┘                    └──────────┘
```

## Requirements

- Node.js 18+ (native `fetch` required)
- OpenCode
- Discord account with access to target servers

## License

MIT
