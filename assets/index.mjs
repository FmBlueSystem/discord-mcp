#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Config ──────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_USER_TOKEN;

if (!TOKEN) {
  console.error("ERROR: DISCORD_USER_TOKEN environment variable is required");
  process.exit(1);
}

const API_BASE = "https://discord.com/api/v10";

const TYPE_MAP = {
  0: "TEXT",
  1: "DM",
  2: "VOICE",
  3: "GROUP_DM",
  4: "CATEGORY",
  5: "ANNOUNCEMENT",
  10: "THREAD",
  11: "PUBLIC_THREAD",
  12: "PRIVATE_THREAD",
  13: "STAGE",
  15: "FORUM",
  16: "MEDIA",
};

// ─── Discord API Helper ──────────────────────────────────────────────────────
async function discordFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: TOKEN,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    ...options,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord API ${resp.status}: ${text.substring(0, 300)}`);
  }

  return resp.json();
}

// ─── Format message ──────────────────────────────────────────────────────────
function formatMessage(msg) {
  const author = msg.author?.global_name || msg.author?.username || "Unknown";
  const reactions =
    msg.reactions?.map((r) => `${r.emoji?.name || "??"}(${r.count})`).join(", ") ||
    "";
  const attachments =
    msg.attachments?.map((a) => `[file: ${a.name} (${a.url})]`).join(", ") || "";
  const embeds = msg.embeds?.length
    ? msg.embeds
        .map((e) => `[embed: ${e.title || e.description?.substring(0, 60) || "rich"}]`)
        .join(", ")
    : "";

  return {
    id: msg.id,
    author,
    authorId: msg.author?.id,
    timestamp: msg.timestamp,
    content: msg.content || "",
    reactions: reactions || undefined,
    attachments: attachments || undefined,
    embeds: embeds || undefined,
    pinned: msg.pinned,
    replyTo: msg.message_reference?.message_id || undefined,
  };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "discord-reader",
  version: "2.0.0",
});

// Tool: List guilds
server.tool(
  "discord_list_guilds",
  "List all Discord servers the user has access to",
  {},
  async () => {
    const guilds = await discordFetch("/users/@me/guilds");
    const result = guilds.map((g) => ({
      id: g.id,
      name: g.name,
      owner: g.owner,
      permissions: g.permissions,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: List channels
server.tool(
  "discord_list_channels",
  "List all channels in a Discord server. Provide guildId. Channels are grouped by category.",
  {
    guildId: z.string().describe("The guild/server ID"),
  },
  async ({ guildId }) => {
    const channels = await discordFetch(`/guilds/${guildId}/channels`);

    // Build category map
    const categories = {};
    for (const c of channels) {
      if (c.type === 4) categories[c.id] = c.name;
    }

    const result = channels
      .sort((a, b) => (a.parent_id || "").localeCompare(b.parent_id || "") || a.position - b.position)
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: TYPE_MAP[c.type] || `UNKNOWN(${c.type})`,
        category: categories[c.parent_id] || null,
        topic: c.topic || null,
        nsfw: c.nsfw || false,
        position: c.position,
      }));

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: Read channel messages
server.tool(
  "discord_read_channel",
  "Read messages from a Discord channel. Returns the latest messages in chronological order.",
  {
    channelId: z.string().describe("The channel ID to read messages from"),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Number of messages to fetch (1-100, default 50)"),
    before: z
      .string()
      .optional()
      .describe("Get messages before this message ID (for pagination - older messages)"),
    after: z
      .string()
      .optional()
      .describe("Get messages after this message ID (for pagination - newer messages)"),
  },
  async ({ channelId, limit = 50, before, after }) => {
    const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (before) params.set("before", before);
    if (after) params.set("after", after);

    const messages = await discordFetch(
      `/channels/${channelId}/messages?${params.toString()}`
    );

    // Get channel info
    let channelInfo;
    try {
      channelInfo = await discordFetch(`/channels/${channelId}`);
    } catch {
      channelInfo = { id: channelId, name: "unknown" };
    }

    const formatted = messages.map(formatMessage);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              channel: {
                id: channelInfo.id,
                name: channelInfo.name,
                type: TYPE_MAP[channelInfo.type] || channelInfo.type,
                topic: channelInfo.topic || null,
              },
              messageCount: formatted.length,
              messages: formatted,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: Search messages
server.tool(
  "discord_search_messages",
  "Search for messages containing specific text in a Discord channel. Searches through recent messages.",
  {
    channelId: z.string().describe("The channel ID to search in"),
    query: z.string().describe("Text to search for in message content (case-insensitive)"),
    limit: z
      .number()
      .optional()
      .default(200)
      .describe("How many recent messages to search through (max 500)"),
  },
  async ({ channelId, query, limit = 200 }) => {
    const queryLower = query.toLowerCase();
    const matches = [];
    let lastId = undefined;
    let remaining = Math.min(limit, 500);

    while (remaining > 0) {
      const batch = Math.min(remaining, 100);
      const params = new URLSearchParams({ limit: String(batch) });
      if (lastId) params.set("before", lastId);

      const msgs = await discordFetch(
        `/channels/${channelId}/messages?${params.toString()}`
      );

      if (msgs.length === 0) break;

      for (const m of msgs) {
        if (m.content && m.content.toLowerCase().includes(queryLower)) {
          matches.push(formatMessage(m));
        }
      }

      lastId = msgs[msgs.length - 1].id;
      remaining -= msgs.length;

      if (msgs.length < batch) break;

      // Rate limit courtesy
      await new Promise((r) => setTimeout(r, 200));
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              messagesSearched: Math.min(limit, 500) - remaining,
              matchesFound: matches.length,
              messages: matches,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: Get channel info
server.tool(
  "discord_get_channel_info",
  "Get detailed info about a specific Discord channel",
  {
    channelId: z.string().describe("The channel ID"),
  },
  async ({ channelId }) => {
    const channel = await discordFetch(`/channels/${channelId}`);

    const info = {
      id: channel.id,
      name: channel.name,
      type: TYPE_MAP[channel.type] || channel.type,
      topic: channel.topic || null,
      nsfw: channel.nsfw || false,
      position: channel.position,
      parentId: channel.parent_id,
      guildId: channel.guild_id,
      createdAt: channel.id
        ? new Date(
            BigInt(channel.id) / 4194304n + 1420070400000n
          ).toISOString()
        : null,
      rateLimit: channel.rate_limit_per_user || 0,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    };
  }
);

// Tool: Get pinned messages
server.tool(
  "discord_get_pinned",
  "Get all pinned messages from a Discord channel",
  {
    channelId: z.string().describe("The channel ID"),
  },
  async ({ channelId }) => {
    const pinned = await discordFetch(`/channels/${channelId}/pins`);
    const formatted = pinned.map(formatMessage);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              channelId,
              pinnedCount: formatted.length,
              messages: formatted,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: Get specific message
server.tool(
  "discord_get_message",
  "Get a specific message by ID from a Discord channel",
  {
    channelId: z.string().describe("The channel ID"),
    messageId: z.string().describe("The message ID"),
  },
  async ({ channelId, messageId }) => {
    const msg = await discordFetch(
      `/channels/${channelId}/messages/${messageId}`
    );

    return {
      content: [{ type: "text", text: JSON.stringify(formatMessage(msg), null, 2) }],
    };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[discord-mcp] MCP server started (REST API mode, no bot required)");
}

main().catch((err) => {
  console.error("[discord-mcp] Fatal error:", err);
  process.exit(1);
});
