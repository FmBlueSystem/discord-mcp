---
name: discord-mcp
description: >
  Build a Discord MCP Server for opencode with full Discord integration via REST API.
  Trigger: When the user wants to connect opencode to Discord, read Discord channels,
  send messages, manage forums, webhooks, reactions, or build a custom MCP server for Discord.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "3.0"
---

## Architecture

```
┌─────────────┐     MCP Protocol      ┌──────────────────┐     REST API       ┌──────────┐
│  OpenCode    │ ◄──────────────────► │  Discord MCP      │ ◄────────────────►│  Discord  │
│  (AI Agent)  │   stdio transport     │  Server (Node.js) │   v10 API          │  Server   │
│              │   tools as JSON       │   index.mjs       │   Bearer token     │           │
└─────────────┘                       └──────────────────┘                    └──────────┘
```

**Key Decision**: Two modes available:

| Mode | When to Use | Requirements |
|------|-------------|--------------|
| **REST API (User Token)** | User is NOT admin of target server | User's Discord token (captured via Playwright) |
| **Bot Mode (Bot Token)** | User IS admin of target server | Bot created in Developer Portal, invited to server |

REST API mode reads everything the user can see. Bot mode requires `MANAGE_GUILD` permission to add.

## When to Use

- User wants AI agent to read Discord channels directly from opencode
- User needs to monitor/search Discord messages without leaving the terminal
- Building a community dashboard or analysis tool
- Any project requiring Discord data in an AI workflow
- Sending messages, managing forums, creating webhooks, or adding reactions via AI

## Project Structure

```
~/.config/opencode/plugins/discord-mcp/
├── index.mjs              # MCP Server (pure ESM, no TypeScript needed)
├── package.json           # Only dependency: @modelcontextprotocol/sdk
└── node_modules/
```

## Step-by-Step Build Instructions

### Step 1: Create project and install dependencies

```bash
mkdir -p ~/.config/opencode/plugins/discord-mcp
cd ~/.config/opencode/plugins/discord-mcp
npm init -y
npm install @modelcontextprotocol/sdk
```

**That's it.** Only ONE dependency. No discord.js, no TypeScript, no build step.

### Step 2: Create the MCP Server

Create `index.mjs` — see [assets/index.mjs](assets/index.mjs) for the full template.

Core structure:

```javascript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOKEN = process.env.DISCORD_USER_TOKEN || process.env.DISCORD_BOT_TOKEN;
const API_BASE = "https://discord.com/api/v10";

// Helper: call Discord API with retry
async function discordFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      headers: { Authorization: TOKEN, "Content-Type": "application/json" },
      ...options,
    });
    if (resp.status === 429) {
      const retryAfter = parseFloat(resp.headers.get("Retry-After") || "1");
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!resp.ok) throw new Error(`Discord API ${resp.status}: ${await resp.text()}`);
    if (resp.status === 204) return null;
    return resp.json();
  }
}

// Define MCP server
const server = new McpServer({ name: "discord-mcp", version: "3.0.0" });

// Register tools
server.tool("tool_name", "description", { param: z.string() }, async ({ param }) => {
  const data = await discordFetch(`/endpoint/${param}`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Step 3: Register tools

Each tool follows this pattern:

```javascript
server.tool(
  "tool_name",                    // MCP tool identifier
  "Description for the AI",       // Helps AI decide when to use it
  {                               // Zod schema for parameters
    channelId: z.string().describe("The channel ID"),
    guildId: z.string().optional().describe("Guild ID (required for name resolution)"),
    limit: z.number().optional().default(50),
  },
  async ({ channelId, guildId, limit }) => {  // Handler
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    const data = await discordFetch(`/channels/${cId}/messages?limit=${limit}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  }
);
```

### Step 4: Get Discord credentials

#### Option A: User Token (works when NOT admin)

Use Playwright to capture the token from a browser session:

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(user_agent="...")
    page = context.new_page()

    # Login
    page.goto("https://discord.com/login")
    page.locator('input[name="email"]').fill(EMAIL)
    page.locator('input[name="password"]').fill(PASSWORD)
    page.locator('button[type="submit"]').click()

    # Intercept API calls to capture token
    user_token = [None]
    def on_response(response):
        auth = response.request.headers.get('authorization', '')
        if auth and not auth.startswith('Bot') and len(auth) > 50:
            user_token[0] = auth
    context.on("response", on_response)

    # Trigger API calls
    page.goto("https://discord.com/channels/@me")
    # Wait for token capture...
```

Token format: ~70 chars, starts with a base64 string (e.g., `OTQ3MzAy...`).

**Limitation**: User tokens expire. May need periodic recapture.

#### Option B: Bot Token (requires server admin)

1. Go to https://discord.com/developers/applications
2. Create New Application → Bot section → Copy Token
3. Enable Privileged Gateway Intents: Presence, Server Members, Message Content
4. Generate invite URL with scopes `bot` + permissions `66560` (read-only)
5. Invite bot to server via generated URL

Token format: `MTQ5NDAx...` (longer, starts with MT).

**Limitation**: Requires `MANAGE_GUILD` permission on target server.

### Step 5: Configure in opencode.json

```json
{
  "mcp": {
    "discord": {
      "type": "local",
      "command": ["node", "/path/to/discord-mcp/index.mjs"],
      "environment": {
        "DISCORD_USER_TOKEN": "your_token_here",
        "DISCORD_DEFAULT_GUILD_ID": "optional_default_guild",
        "DISCORD_BANNED_GUILD_IDS": "optional,comma,separated,guild,ids",
        "DISCORD_BANNED_USER_IDS": "optional,comma,separated,user,ids"
      }
    }
  }
}
```

For bot mode, use `DISCORD_BOT_TOKEN` instead.

## 22 MCP Tools Available

### Guilds & Server Info (2 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `discord_list_guilds` | List all servers the user/bot has access to | (none) |
| `discord_get_server_info` | Get detailed server info (roles, members, icon) | `guildId` |

### Channels (4 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `discord_list_channels` | List all channels grouped by category | `guildId` |
| `discord_get_channel_info` | Get detailed channel metadata | `channelId`, `guildId` |
| `discord_create_channel` | Create a new text/voice/forum channel | `guildId`, `name`, `type`, `topic`, `parentId` |
| `discord_delete_channel` | Delete a channel | `channelId`, `guildId`, `reason` |

### Messages (6 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `discord_read_channel` | Read messages from a channel (paginated) | `channelId`, `guildId`, `limit`, `before`, `after` |
| `discord_send_message` | Send a message to a channel | `channelId`, `guildId`, `message` |
| `discord_delete_message` | Delete a specific message | `channelId`, `guildId`, `messageId`, `reason` |
| `discord_search_messages` | Search messages by text (client-side filter) | `channelId`, `guildId`, `query`, `limit` |
| `discord_get_message` | Get a specific message by ID | `channelId`, `guildId`, `messageId` |
| `discord_get_pinned` | Get all pinned messages | `channelId`, `guildId` |

### Forums (4 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `discord_list_forums` | List all forum channels with tags | `guildId` |
| `discord_get_forum_post` | Read messages from a forum thread | `threadId`, `limit` |
| `discord_create_forum_post` | Create a new forum post with tags | `forumChannelId`, `guildId`, `title`, `content`, `tags` |
| `discord_reply_to_forum` | Reply to a forum thread | `threadId`, `message` |

### Reactions (3 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `discord_add_reaction` | Add emoji reaction to message | `channelId`, `guildId`, `messageId`, `emoji` |
| `discord_remove_reaction` | Remove your reaction from message | `channelId`, `guildId`, `messageId`, `emoji` |
| `discord_add_multiple_reactions` | Add multiple emojis at once | `channelId`, `guildId`, `messageId`, `emojis` |

### Webhooks (4 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `discord_create_webhook` | Create a webhook in a channel | `channelId`, `guildId`, `name` |
| `discord_list_webhooks` | List webhooks in a channel | `channelId`, `guildId` |
| `discord_send_webhook_message` | Send message via webhook (custom identity) | `webhookId`, `webhookToken`, `content`, `username`, `avatarUrl` |
| `discord_delete_webhook` | Delete a webhook | `webhookId`, `webhookToken` |

## Discord API v10 Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/users/@me/guilds` | GET | List user's servers |
| `/guilds/{guildId}` | GET | Get server details |
| `/guilds/{guildId}/channels` | GET | List channels |
| `/guilds/{guildId}/channels` | POST | Create channel |
| `/channels/{channelId}` | GET/DELETE | Get info or delete channel |
| `/channels/{channelId}/messages` | GET/POST | Read or send messages |
| `/channels/{channelId}/messages/{messageId}` | GET/DELETE | Get or delete message |
| `/channels/{channelId}/pins` | GET | Get pinned messages |
| `/channels/{channelId}/messages/{id}/reactions/{emoji}/@me` | PUT/DELETE | Add/remove reaction |
| `/channels/{forumId}/threads` | POST | Create forum post |
| `/channels/{channelId}/webhooks` | GET/POST | List or create webhooks |
| `/webhooks/{id}/{token}` | POST/DELETE | Send or delete webhook |

## Rate Limits

- Discord allows ~5 requests per second per route
- The `discord_search_messages` tool includes 200ms delays between paginated requests
- v3.0 includes built-in rate limit retry: up to 3 attempts with `Retry-After` header backoff

## Key Learnings from Building This

1. **Don't use discord.js for read-only MCP** — The REST API is simpler, lighter (1 dep vs 116), and doesn't need a WebSocket gateway connection
2. **User Token vs Bot Token** — Always try User Token first (no server admin needed). Fall back to Bot only when user IS admin
3. **Discord OAuth2 invite is broken for automation** — Discord redirects to desktop app, has CAPTCHAs, and blocks automated browser flows. Use the API directly instead
4. **Playwright network interception** — The most reliable way to capture a user token: listen to `context.on("response")` and grab the `Authorization` header from any API call
5. **Channel types** — Discord has 17+ channel types (TEXT=0, VOICE=2, CATEGORY=4, FORUM=15, etc.). Always filter by type when listing channels
6. **Message pagination** — Discord returns messages newest-first. Use `before` parameter with the oldest message ID to paginate backwards
7. **MCP stdio transport** — The server communicates via stdin/stdout JSON-RPC. Never `console.log()` to stdout — use `console.error()` for debug logs
8. **Channel name resolution** — Users can pass `"general"` instead of `1198053804571111496`. The server caches guild/channel lookups for fast subsequent calls. Always requires `guildId` for name resolution.
9. **Rate limit handling with retry** — Discord returns 429 with `Retry-After` header. The v3.0 server retries up to 3 times with exponential backoff built in.
10. **Banned guilds/users** — Set `DISCORD_BANNED_GUILD_IDS` and `DISCORD_BANNED_USER_IDS` env vars (comma-separated) to block writes to specific servers or filter messages from specific users.
11. **Error handling with solutions** — Each Discord error code maps to a human-readable solution (e.g., 40001 = "Token invalid or expired. Re-capture your Discord token.")
12. **Forum posts are threads** — In Discord API, forum posts ARE threads. Use `/channels/{forumId}/threads` to create, then `/channels/{threadId}/messages` to read/reply.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_USER_TOKEN` | Yes* | User's Discord token (captured via Playwright) |
| `DISCORD_BOT_TOKEN` | Yes* | Bot token (alternative to user token) |
| `DISCORD_DEFAULT_GUILD_ID` | No | Default guild ID — lets you omit guildId from tools |
| `DISCORD_BANNED_GUILD_IDS` | No | Comma-separated guild IDs to block write operations |
| `DISCORD_BANNED_USER_IDS` | No | Comma-separated user IDs to filter from message reads |

*One of DISCORD_USER_TOKEN or DISCORD_BOT_TOKEN is required.

## Commands

```bash
# Create project from scratch
mkdir -p ~/.config/opencode/plugins/discord-mcp
cd ~/.config/opencode/plugins/discord-mcp && npm init -y && npm install @modelcontextprotocol/sdk

# Test the server starts without errors
DISCORD_USER_TOKEN="your_token" timeout 5 node index.mjs
# Should output: [discord-mcp] v3.0.0 started — 22 tools, REST API mode

# Verify Discord API connectivity
curl -H "Authorization: YOUR_TOKEN" https://discord.com/api/v10/users/@me

# List guilds
curl -H "Authorization: YOUR_TOKEN" https://discord.com/api/v10/users/@me/guilds

# Read messages from a channel
curl -H "Authorization: YOUR_TOKEN" "https://discord.com/api/v10/channels/CHANNEL_ID/messages?limit=10"
```

## Prompt Template for Future Projects

When asking an AI to build this for a new project, use:

```
Build a Discord MCP Server for opencode following the discord-mcp skill.
Requirements:
- REST API mode (no discord.js)
- Single dependency: @modelcontextprotocol/sdk
- Auth: [User Token / Bot Token]
- Target server: [server name or ID]
- Tools needed: [list which of the 22 tools you need]
- Banned guilds: [optional: comma-separated guild IDs to block writes]
- Banned users: [optional: comma-separated user IDs to filter from reads]
- Install to: ~/.config/opencode/plugins/discord-mcp/
Configure in opencode.json under mcp.discord.
```

## Resources

- **Template**: See [assets/index.mjs](assets/index.mjs) for the full copy-paste-ready MCP server
- **Discord API Docs**: https://discord.com/developers/docs/reference
- **MCP SDK Docs**: https://modelcontextprotocol.io/docs/sdk
