---
name: discord-mcp
description: >
  Build a Discord MCP Server for opencode that reads channels via REST API.
  Trigger: When the user wants to connect opencode to Discord, read Discord channels,
  create a Discord integration, or build a custom MCP server for Discord.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "2.0"
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

const TOKEN = process.env.DISCORD_USER_TOKEN;  // or DISCORD_BOT_TOKEN
const API_BASE = "https://discord.com/api/v10";

// Helper: call Discord API
async function discordFetch(endpoint) {
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      Authorization: TOKEN,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) throw new Error(`Discord API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// Define MCP server
const server = new McpServer({ name: "discord-reader", version: "2.0.0" });

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
    limit: z.number().optional().default(50),
  },
  async ({ channelId, limit }) => {  // Handler
    const data = await discordFetch(`/channels/${channelId}/messages?limit=${limit}`);
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
        "DISCORD_USER_TOKEN": "your_token_here"
      }
    }
  }
}
```

For bot mode, use `DISCORD_BOT_TOKEN` instead.

## 7 MCP Tools Available

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `discord_list_guilds` | List all servers the user/bot has access to | (none) |
| `discord_list_channels` | List all channels in a server | `guildId` |
| `discord_read_channel` | Read messages from a channel | `channelId`, `limit`, `before`, `after` |
| `discord_search_messages` | Search messages by text content | `channelId`, `query`, `limit` |
| `discord_get_channel_info` | Get detailed channel metadata | `channelId` |
| `discord_get_pinned` | Get pinned messages | `channelId` |
| `discord_get_message` | Get a specific message by ID | `channelId`, `messageId` |

## Discord API v10 Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/users/@me/guilds` | GET | List user's servers |
| `/guilds/{guildId}/channels` | GET | List channels in a server |
| `/channels/{channelId}/messages` | GET | Read messages (max 100 per request) |
| `/channels/{channelId}/pins` | GET | Get pinned messages |
| `/channels/{channelId}/messages/{messageId}` | GET | Get specific message |
| `/channels/{channelId}` | GET | Get channel info |

## Rate Limits

- Discord allows ~5 requests per second per route
- The `discord_search_messages` tool includes 200ms delays between paginated requests
- If you hit rate limits, implement exponential backoff with `Retry-After` header

## Key Learnings from Building This

1. **Don't use discord.js for read-only MCP** — The REST API is simpler, lighter (1 dep vs 116), and doesn't need a WebSocket gateway connection
2. **User Token vs Bot Token** — Always try User Token first (no server admin needed). Fall back to Bot only when user IS admin
3. **Discord OAuth2 invite is broken for automation** — Discord redirects to desktop app, has CAPTCHAs, and blocks automated browser flows. Use the API directly instead
4. **Playwright network interception** — The most reliable way to capture a user token: listen to `context.on("response")` and grab the `Authorization` header from any API call
5. **Channel types** — Discord has 17+ channel types (TEXT=0, VOICE=2, CATEGORY=4, FORUM=15, etc.). Always filter by type when listing channels
6. **Message pagination** — Discord returns messages newest-first. Use `before` parameter with the oldest message ID to paginate backwards
7. **MCP stdio transport** — The server communicates via stdin/stdout JSON-RPC. Never `console.log()` to stdout — use `console.error()` for debug logs

## Commands

```bash
# Create project from scratch
mkdir -p ~/.config/opencode/plugins/discord-mcp
cd ~/.config/opencode/plugins/discord-mcp && npm init -y && npm install @modelcontextprotocol/sdk

# Test the server starts without errors
DISCORD_USER_TOKEN="your_token" timeout 5 node index.mjs

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
- Tools needed: [list which of the 7 tools you need]
- Install to: ~/.config/opencode/plugins/discord-mcp/
Configure in opencode.json under mcp.discord.
```

## Resources

- **Template**: See [assets/index.mjs](assets/index.mjs) for the full copy-paste-ready MCP server
- **Discord API Docs**: https://discord.com/developers/docs/reference
- **MCP SDK Docs**: https://modelcontextprotocol.io/docs/sdk
