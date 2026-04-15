# discord-mcp

[![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)](https://github.com/FmBlueSystem/discord-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](https://github.com/FmBlueSystem/discord-mcp)

Discord MCP Server — 22 tools for AI agents to interact with Discord via REST API.

No discord.js. No WebSocket gateway. Single dependency. Works with user tokens (no admin needed) or bot tokens.

## Features

- **22 MCP Tools** across 6 categories — Guilds, Channels, Messages, Forums, Reactions, Webhooks
- **Channel name resolution** — pass `"general"` instead of numeric IDs
- **Two auth modes** — User Token (no admin, captured via Playwright) or Bot Token (admin required)
- **REST API only** — no discord.js, no WebSocket gateway, 1 dependency (`@modelcontextprotocol/sdk`)
- **Rate limit handling** — automatic retry with `Retry-After` header (up to 3 attempts)
- **Error handling with solutions** — Discord error codes map to human-readable fixes
- **Banned guilds/users** — environment variables to block writes or filter reads
- **Forum support** — list forums, create posts, reply to threads
- **Webhook support** — create, list, send messages as custom identity, delete webhooks
- **Reactions** — add, remove, and batch add emoji reactions

## Tools

### Guilds (2)

| Tool | Description |
|------|-------------|
| `discord_list_guilds` | List all servers the authenticated user/bot has access to |
| `discord_get_guild` | Get detailed info about a specific guild |

### Channels (4)

| Tool | Description |
|------|-------------|
| `discord_list_channels` | List all channels in a guild |
| `discord_get_channel_info` | Get metadata for a specific channel |
| `discord_create_channel` | Create a new text or voice channel |
| `discord_modify_channel` | Update channel properties (name, topic, slowmode, etc.) |

### Messages (6)

| Tool | Description |
|------|-------------|
| `discord_read_channel` | Read messages from a channel with pagination |
| `discord_get_message` | Get a specific message by ID |
| `discord_get_pinned` | Get pinned messages in a channel |
| `discord_send_message` | Send a message to a channel |
| `discord_search_messages` | Search messages by text content |
| `discord_delete_message` | Delete a specific message |

### Forums (4)

| Tool | Description |
|------|-------------|
| `discord_list_forum_posts` | List posts in a forum channel |
| `discord_create_forum_post` | Create a new post in a forum channel |
| `discord_get_forum_post` | Get a specific forum post with its thread |
| `discord_reply_to_thread` | Reply to an existing forum thread |

### Reactions (3)

| Tool | Description |
|------|-------------|
| `discord_add_reaction` | Add an emoji reaction to a message |
| `discord_remove_reaction` | Remove a specific emoji reaction from a message |
| `discord_batch_add_reactions` | Add multiple emoji reactions to a message at once |

### Webhooks (4)

| Tool | Description |
|------|-------------|
| `discord_create_webhook` | Create a webhook in a channel |
| `discord_list_webhooks` | List all webhooks in a channel or guild |
| `discord_send_webhook_message` | Send a message as a webhook with custom username/avatar |
| `discord_delete_webhook` | Delete a webhook |

## Quick Start

### 1. Install

```bash
mkdir -p ~/.config/opencode/plugins/discord-mcp
cd ~/.config/opencode/plugins/discord-mcp
npm init -y
npm install @modelcontextprotocol/sdk
```

Copy `assets/index.mjs` to the project root:

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
4. Invite bot with `bot` scope and appropriate permissions

### 3. Configure

Add to your `opencode.json` (or equivalent MCP config):

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

For bot mode, use `DISCORD_BOT_TOKEN` instead of `DISCORD_USER_TOKEN`.

### 4. Restart

The MCP server starts automatically on next launch. All 22 tools are available to your AI agent.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_USER_TOKEN` | Yes* | Discord user token (use with user auth mode) |
| `DISCORD_BOT_TOKEN` | Yes* | Discord bot token (use with bot auth mode) |
| `DISCORD_BANNED_GUILDS` | No | Comma-separated guild IDs to block all operations |
| `DISCORD_BANNED_USERS` | No | Comma-separated user IDs to filter from reads |

*\*Provide one of `DISCORD_USER_TOKEN` or `DISCORD_BOT_TOKEN`.*

## Channel Name Resolution

Instead of passing numeric channel IDs, you can use channel names:

```
# These are equivalent:
channelId: "1234567890"
channelId: "general"
```

When a non-numeric value is passed as `channelId`, the server resolves it by listing channels in the guild and matching by name. This requires `guildId` to be provided in the same call for name lookups to work.

## Auth Modes

| | User Token | Bot Token |
|---|---|---|
| **Setup** | Playwright capture from browser | Discord Developer Portal |
| **Admin required** | No | Yes |
| **Access scope** | Servers your account is in | Servers bot is invited to |
| **Env variable** | `DISCORD_USER_TOKEN` | `DISCORD_BOT_TOKEN` |

User tokens are recommended for personal use. Bot tokens are recommended for shared/team setups.

## Rate Limits & Error Handling

**Rate limits** are handled automatically. When Discord returns a 429, the server reads the `Retry-After` header and retries up to 3 times before failing.

**Error codes** are mapped to human-readable solutions. For example:

| Code | Meaning | Solution |
|------|---------|----------|
| 10003 | Unknown Channel | Verify channel ID or provide `guildId` for name resolution |
| 50001 | Missing Access | Bot needs additional permissions or user lacks access |
| 50013 | Missing Permissions | Grant the required permission in server settings |

## Prompt Template

Use this prompt to add Discord capabilities to any MCP-compatible AI agent:

```markdown
You have access to Discord via MCP tools. All tool names start with `discord_`.

Key behaviors:
- Pass channel names (e.g. "general") instead of IDs. Include guildId for name resolution.
- guildId is required for any operation that might need to resolve channel names.
- Use pagination (before/after cursors) for reading large channel histories.
- For forum channels, use the forum-specific tools (discord_list_forum_posts, etc.).
- Webhooks allow sending messages with a custom username and avatar URL.
```

## License

[Apache-2.0](https://github.com/FmBlueSystem/discord-mcp/blob/main/LICENSE) © FmBlueSystem
