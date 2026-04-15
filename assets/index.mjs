#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Config ──────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_USER_TOKEN || process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("ERROR: DISCORD_USER_TOKEN or DISCORD_BOT_TOKEN required");
  process.exit(1);
}

const API_BASE = "https://discord.com/api/v10";
const BANNED_GUILDS = new Set((process.env.DISCORD_BANNED_GUILD_IDS || "").split(",").filter(Boolean));
const BANNED_USERS = new Set((process.env.DISCORD_BANNED_USER_IDS || "").split(",").filter(Boolean));
const DEFAULT_GUILD = process.env.DISCORD_DEFAULT_GUILD_ID || "";

const TYPE_MAP = { 0:"TEXT",1:"DM",2:"VOICE",3:"GROUP_DM",4:"CATEGORY",5:"ANNOUNCEMENT",10:"THREAD",11:"PUBLIC_THREAD",12:"PRIVATE_THREAD",13:"STAGE",15:"FORUM",16:"MEDIA" };

// ─── Error Handler ───────────────────────────────────────────────────────────
function handleDiscordError(err) {
  const msg = typeof err === "string" ? err : err?.message || String(err);
  const code = err?.discordCode || 0;
  const solutions = {
    40001: "Token invalid or expired. Solution: Re-capture your Discord token.",
    10004: "Server not found. Solution: Check the server ID or that the bot/user is a member.",
    50001: "Missing access. Solution: Check channel permissions and bot/user membership.",
    50013: "Missing permissions. Solution: Grant the required permissions in server settings.",
    50034: "Invalid message content. Solution: Messages must be 1-2000 characters.",
    429: "Rate limited by Discord. Solution: Wait a moment and retry.",
  };
  const solution = solutions[code] || `Discord API error (code ${code || "unknown"}): ${msg.substring(0, 200)}`;
  return { content: [{ type: "text", text: `Error: ${solution}` }], isError: true };
}

// ─── Discord API Helper with Rate Limit Retry ────────────────────────────────
async function discordFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch(url, {
      headers: { Authorization: TOKEN, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      ...options,
    });
    if (resp.status === 429) {
      const retryAfter = parseFloat(resp.headers.get("Retry-After") || "1");
      console.error(`[discord-mcp] Rate limited. Retrying after ${retryAfter}s (attempt ${attempt + 1})`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!resp.ok) {
      let body;
      try { body = await resp.json(); } catch { body = {}; }
      const err = new Error(`Discord API ${resp.status}: ${JSON.stringify(body).substring(0, 300)}`);
      err.discordCode = body?.code || 0;
      throw err;
    }
    if (resp.status === 204) return null;
    return resp.json();
  }
  throw new Error("Max retries exceeded for rate-limited request");
}

// ─── Channel/Guild Name Resolution ──────────────────────────────────────────
const channelCache = new Map();
const guildCache = new Map();

async function resolveGuildId(guildRef) {
  if (!guildRef) return DEFAULT_GUILD || null;
  if (/^\d+$/.test(guildRef)) return guildRef;
  if (guildCache.has(guildRef.toLowerCase())) return guildCache.get(guildRef.toLowerCase());
  const guilds = await discordFetch("/users/@me/guilds");
  for (const g of guilds) {
    guildCache.set(g.name.toLowerCase(), g.id);
    guildCache.set(g.id, g.id);
  }
  return guildCache.get(guildRef.toLowerCase()) || null;
}

async function resolveChannelId(guildId, channelRef) {
  if (!channelRef) return null;
  if (/^\d+$/.test(channelRef)) return channelRef;
  if (!guildId) return null;
  const cacheKey = `${guildId}:${channelRef.toLowerCase()}`;
  if (channelCache.has(cacheKey)) return channelCache.get(cacheKey);
  const channels = await discordFetch(`/guilds/${guildId}/channels`);
  for (const c of channels) {
    channelCache.set(`${guildId}:${c.name.toLowerCase().replace(/^#/, "")}`, c.id);
    channelCache.set(`${guildId}:${c.id}`, c.id);
  }
  return channelCache.get(cacheKey) || null;
}

// ─── Format message ──────────────────────────────────────────────────────────
function formatMessage(msg) {
  const author = msg.author?.global_name || msg.author?.username || "Unknown";
  const reactions = msg.reactions?.map(r => `${r.emoji?.name || "??"}(${r.count})`).join(", ") || "";
  const attachments = msg.attachments?.map(a => `[file: ${a.name} (${a.url})]`).join(", ") || "";
  const embeds = msg.embeds?.length ? msg.embeds.map(e => `[embed: ${e.title || e.description?.substring(0, 60) || "rich"}]`).join(", ") : "";
  return {
    id: msg.id, author, authorId: msg.author?.id, timestamp: msg.timestamp,
    content: msg.content || "", reactions: reactions || undefined,
    attachments: attachments || undefined, embeds: embeds || undefined,
    pinned: msg.pinned, replyTo: msg.message_reference?.message_id || undefined,
  };
}

function isBanned(msg) {
  if (!msg || !msg.author) return false;
  if (BANNED_USERS.has(msg.author.id)) return true;
  return false;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({ name: "discord-mcp", version: "3.0.0" });

// ─── TOOLS: Guilds & Server Info ─────────────────────────────────────────────

server.tool("discord_list_guilds", "List all Discord servers the user/bot has access to.", {}, async () => {
  try {
    const guilds = await discordFetch("/users/@me/guilds");
    const result = guilds.map(g => ({
      id: g.id, name: g.name, owner: g.owner, permissions: g.permissions,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
    }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_get_server_info", "Get detailed server information including channels, roles, member count, and icon.", {
  guildId: z.string().describe("Guild ID or name"),
}, async ({ guildId }) => {
  try {
    const gId = await resolveGuildId(guildId);
    if (!gId) return { content: [{ type: "text", text: `Error: Could not resolve guild '${guildId}'` }], isError: true };
    const guild = await discordFetch(`/guilds/${gId}`);
    return { content: [{ type: "text", text: JSON.stringify({
      id: guild.id, name: guild.name, description: guild.description || null,
      memberCount: guild.approximate_member_count, icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png` : null,
      ownerId: guild.owner_id, createdAt: new Date(BigInt(guild.id) / 4194304n + 1420070400000n).toISOString(),
      features: guild.features?.slice(0, 10), roles: guild.roles?.map(r => ({ id: r.id, name: r.name, color: r.color })),
    }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

// ─── TOOLS: Channels ────────────────────────────────────────────────────────

server.tool("discord_list_channels", "List all channels in a Discord server, grouped by category.", {
  guildId: z.string().describe("Guild/server ID or name"),
}, async ({ guildId }) => {
  try {
    const gId = await resolveGuildId(guildId);
    if (!gId) return { content: [{ type: "text", text: `Error: Could not resolve guild '${guildId}'` }], isError: true };
    const channels = await discordFetch(`/guilds/${gId}/channels`);
    const categories = {};
    for (const c of channels) { if (c.type === 4) categories[c.id] = c.name; }
    const result = channels.sort((a, b) => (a.parent_id || "").localeCompare(b.parent_id || "") || a.position - b.position)
      .map(c => ({ id: c.id, name: c.name, type: TYPE_MAP[c.type] || `UNKNOWN(${c.type})`, category: categories[c.parent_id] || null, topic: c.topic || null, nsfw: c.nsfw || false }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_get_channel_info", "Get detailed info about a specific Discord channel.", {
  channelId: z.string().describe("Channel ID or name (requires guildId for name resolution)"),
  guildId: z.string().optional().describe("Guild ID or name (required if channelId is a name)"),
}, async ({ channelId, guildId }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    const ch = await discordFetch(`/channels/${cId}`);
    return { content: [{ type: "text", text: JSON.stringify({
      id: ch.id, name: ch.name, type: TYPE_MAP[ch.type] || ch.type, topic: ch.topic || null,
      nsfw: ch.nsfw || false, position: ch.position, parentId: ch.parent_id, guildId: ch.guild_id,
      rateLimit: ch.rate_limit_per_user || 0,
    }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_create_channel", "Create a new text channel in a Discord server.", {
  guildId: z.string().describe("Guild ID or name"),
  name: z.string().describe("Channel name (lowercase, no spaces, use hyphens)"),
  type: z.number().optional().default(0).describe("Channel type: 0=text, 2=voice, 5=announcement, 15=forum"),
  topic: z.string().optional().describe("Channel topic/description"),
  parentId: z.string().optional().describe("Parent category ID"),
}, async ({ guildId, name, type = 0, topic, parentId }) => {
  try {
    const gId = await resolveGuildId(guildId);
    if (!gId) return { content: [{ type: "text", text: `Error: Could not resolve guild '${guildId}'` }], isError: true };
    const body = { name, type };
    if (topic) body.topic = topic;
    if (parentId) body.parent_id = parentId;
    const ch = await discordFetch(`/guilds/${gId}/channels`, { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text", text: JSON.stringify({ id: ch.id, name: ch.name, type: TYPE_MAP[ch.type] }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_delete_channel", "Delete a Discord channel.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name (required if channelId is a name)"),
  reason: z.string().optional().describe("Reason for deletion (audit log)"),
}, async ({ channelId, guildId, reason }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    await discordFetch(`/channels/${cId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Channel ${cId} deleted successfully.` }] };
  } catch (e) { return handleDiscordError(e); }
});

// ─── TOOLS: Messages ────────────────────────────────────────────────────────

server.tool("discord_read_channel", "Read messages from a Discord channel. Returns messages in chronological order.", {
  channelId: z.string().describe("Channel ID or name (requires guildId for name)"),
  guildId: z.string().optional().describe("Guild ID or name (required if channelId is a name)"),
  limit: z.number().optional().default(50).describe("Number of messages (1-100, default 50)"),
  before: z.string().optional().describe("Get messages before this message ID (pagination)"),
  after: z.string().optional().describe("Get messages after this message ID (pagination)"),
}, async ({ channelId, guildId, limit = 50, before, after }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (before) params.set("before", before);
    if (after) params.set("after", after);
    const messages = await discordFetch(`/channels/${cId}/messages?${params}`);
    let channelInfo;
    try { channelInfo = await discordFetch(`/channels/${cId}`); } catch { channelInfo = { id: cId, name: "unknown" }; }
    const formatted = messages.filter(m => !isBanned(m)).map(formatMessage);
    return { content: [{ type: "text", text: JSON.stringify({ channel: { id: channelInfo.id, name: channelInfo.name, type: TYPE_MAP[channelInfo.type] || channelInfo.type }, messageCount: formatted.length, messages: formatted }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_send_message", "Send a message to a Discord channel.", {
  channelId: z.string().describe("Channel ID or name (requires guildId for name)"),
  guildId: z.string().optional().describe("Guild ID or name (required if channelId is a name)"),
  message: z.string().describe("Message content to send (1-2000 characters)"),
}, async ({ channelId, guildId, message }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    if (BANNED_GUILDS.size > 0) { const ch = await discordFetch(`/channels/${cId}`); if (ch.guild_id && BANNED_GUILDS.has(ch.guild_id)) return { content: [{ type: "text", text: "Error: This guild is blocked." }], isError: true }; }
    const msg = await discordFetch(`/channels/${cId}/messages`, { method: "POST", body: JSON.stringify({ content: message }) });
    return { content: [{ type: "text", text: JSON.stringify({ sent: true, messageId: msg.id, channelId: cId, timestamp: msg.timestamp }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_delete_message", "Delete a specific message from a Discord channel.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name (required if channelId is a name)"),
  messageId: z.string().describe("The message ID to delete"),
  reason: z.string().optional().describe("Reason for deletion (audit log)"),
}, async ({ channelId, guildId, messageId, reason }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    await discordFetch(`/channels/${cId}/messages/${messageId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Message ${messageId} deleted from channel ${cId}.` }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_search_messages", "Search for messages containing specific text in a Discord channel.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name (required if channelId is a name)"),
  query: z.string().describe("Text to search for (case-insensitive)"),
  limit: z.number().optional().default(200).describe("How many recent messages to search (max 500)"),
}, async ({ channelId, guildId, query, limit = 200 }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    const queryLower = query.toLowerCase();
    const matches = [];
    let lastId, remaining = Math.min(limit, 500);
    while (remaining > 0) {
      const batch = Math.min(remaining, 100);
      const params = new URLSearchParams({ limit: String(batch) });
      if (lastId) params.set("before", lastId);
      const msgs = await discordFetch(`/channels/${cId}/messages?${params}`);
      if (msgs.length === 0) break;
      for (const m of msgs) { if (m.content && m.content.toLowerCase().includes(queryLower) && !isBanned(m)) matches.push(formatMessage(m)); }
      lastId = msgs[msgs.length - 1].id;
      remaining -= msgs.length;
      if (msgs.length < batch) break;
      await new Promise(r => setTimeout(r, 200));
    }
    return { content: [{ type: "text", text: JSON.stringify({ query, messagesSearched: Math.min(limit, 500) - remaining, matchesFound: matches.length, messages: matches }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_get_pinned", "Get all pinned messages from a Discord channel.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name (required if channelId is a name)"),
}, async ({ channelId, guildId }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    const pinned = await discordFetch(`/channels/${cId}/pins`);
    return { content: [{ type: "text", text: JSON.stringify({ channelId: cId, pinnedCount: pinned.length, messages: pinned.map(formatMessage) }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_get_message", "Get a specific message by ID.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name (required if channelId is a name)"),
  messageId: z.string().describe("The message ID"),
}, async ({ channelId, guildId, messageId }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    const msg = await discordFetch(`/channels/${cId}/messages/${messageId}`);
    return { content: [{ type: "text", text: JSON.stringify(formatMessage(msg), null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

// ─── TOOLS: Forum ────────────────────────────────────────────────────────────

server.tool("discord_list_forums", "List all forum channels in a Discord server.", {
  guildId: z.string().describe("Guild ID or name"),
}, async ({ guildId }) => {
  try {
    const gId = await resolveGuildId(guildId);
    if (!gId) return { content: [{ type: "text", text: `Error: Could not resolve guild '${guildId}'` }], isError: true };
    const channels = await discordFetch(`/guilds/${gId}/channels`);
    const forums = channels.filter(c => c.type === 15).map(c => ({ id: c.id, name: c.name, topic: c.topic || null, tags: c.available_tags?.map(t => ({ id: t.id, name: t.name })) || [] }));
    return { content: [{ type: "text", text: JSON.stringify(forums, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_get_forum_post", "Get messages from a forum thread/post.", {
  threadId: z.string().describe("The thread/post ID"),
  limit: z.number().optional().default(50).describe("Number of messages (1-100)"),
}, async ({ threadId, limit = 50 }) => {
  try {
    const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    const messages = await discordFetch(`/channels/${threadId}/messages?${params}`);
    let threadInfo;
    try { threadInfo = await discordFetch(`/channels/${threadId}`); } catch { threadInfo = { id: threadId, name: "unknown" }; }
    return { content: [{ type: "text", text: JSON.stringify({ thread: { id: threadInfo.id, name: threadInfo.name }, messageCount: messages.length, messages: messages.map(formatMessage) }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_create_forum_post", "Create a new post in a Discord forum channel.", {
  forumChannelId: z.string().describe("Forum channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name (required if forumChannelId is a name)"),
  title: z.string().describe("Post title"),
  content: z.string().describe("Post body content"),
  tags: z.array(z.string()).optional().describe("Tag names or IDs to apply"),
}, async ({ forumChannelId, guildId, title, content, tags }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const fId = await resolveChannelId(gId, forumChannelId);
    if (!fId) return { content: [{ type: "text", text: `Error: Could not resolve forum '${forumChannelId}'` }], isError: true };
    const body = { name: title, message: { content }, type: 11 };
    if (tags?.length) {
      const forum = await discordFetch(`/channels/${fId}`);
      const tagIds = tags.map(t => { const found = forum.available_tags?.find(at => at.name.toLowerCase() === t.toLowerCase() || at.id === t); return found?.id; }).filter(Boolean);
      if (tagIds.length) body.applied_tags = tagIds;
    }
    const thread = await discordFetch(`/channels/${fId}/threads`, { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text", text: JSON.stringify({ created: true, threadId: thread.id, title: thread.name }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_reply_to_forum", "Reply to a forum post/thread.", {
  threadId: z.string().describe("Thread/post ID"),
  message: z.string().describe("Reply content"),
}, async ({ threadId, message }) => {
  try {
    const msg = await discordFetch(`/channels/${threadId}/messages`, { method: "POST", body: JSON.stringify({ content: message }) });
    return { content: [{ type: "text", text: JSON.stringify({ sent: true, messageId: msg.id, threadId }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

// ─── TOOLS: Reactions ────────────────────────────────────────────────────────

server.tool("discord_add_reaction", "Add an emoji reaction to a message.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name"),
  messageId: z.string().describe("Message ID"),
  emoji: z.string().describe("Emoji to react with (e.g. 👍, 🎉)"),
}, async ({ channelId, guildId, messageId, emoji }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    await discordFetch(`/channels/${cId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: "PUT" });
    return { content: [{ type: "text", text: `Reaction ${emoji} added to message ${messageId}.` }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_remove_reaction", "Remove your reaction from a message.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name"),
  messageId: z.string().describe("Message ID"),
  emoji: z.string().describe("Emoji to remove"),
}, async ({ channelId, guildId, messageId, emoji }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    await discordFetch(`/channels/${cId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Reaction ${emoji} removed from message ${messageId}.` }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_add_multiple_reactions", "Add multiple emoji reactions to a message at once.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name"),
  messageId: z.string().describe("Message ID"),
  emojis: z.array(z.string()).describe("Array of emojis to add"),
}, async ({ channelId, guildId, messageId, emojis }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    const results = [];
    for (const emoji of emojis) {
      try {
        await discordFetch(`/channels/${cId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, { method: "PUT" });
        results.push({ emoji, status: "added" });
      } catch (e) { results.push({ emoji, status: "failed", error: e.message }); }
    }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

// ─── TOOLS: Webhooks ────────────────────────────────────────────────────────

server.tool("discord_create_webhook", "Create a webhook in a Discord channel.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name"),
  name: z.string().describe("Webhook name"),
}, async ({ channelId, guildId, name }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    const wh = await discordFetch(`/channels/${cId}/webhooks`, { method: "POST", body: JSON.stringify({ name }) });
    return { content: [{ type: "text", text: JSON.stringify({ id: wh.id, name: wh.name, token: wh.token, url: `https://discord.com/api/webhooks/${wh.id}/${wh.token}` }, null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_list_webhooks", "List all webhooks in a Discord channel.", {
  channelId: z.string().describe("Channel ID or name"),
  guildId: z.string().optional().describe("Guild ID or name"),
}, async ({ channelId, guildId }) => {
  try {
    const gId = guildId ? await resolveGuildId(guildId) : DEFAULT_GUILD;
    const cId = await resolveChannelId(gId, channelId);
    if (!cId) return { content: [{ type: "text", text: `Error: Could not resolve channel '${channelId}'` }], isError: true };
    const webhooks = await discordFetch(`/channels/${cId}/webhooks`);
    return { content: [{ type: "text", text: JSON.stringify(webhooks.map(w => ({ id: w.id, name: w.name, channelId: w.channel_id, token: w.token })), null, 2) }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_send_webhook_message", "Send a message via webhook (posts as a custom bot identity).", {
  webhookId: z.string().describe("Webhook ID"),
  webhookToken: z.string().describe("Webhook token"),
  content: z.string().describe("Message content"),
  username: z.string().optional().describe("Override username for this message"),
  avatarUrl: z.string().optional().describe("Override avatar URL for this message"),
}, async ({ webhookId, webhookToken, content, username, avatarUrl }) => {
  try {
    const body = { content };
    if (username) body.username = username;
    if (avatarUrl) body.avatar_url = avatarUrl;
    await discordFetch(`/webhooks/${webhookId}/${webhookToken}`, { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text", text: "Webhook message sent successfully." }] };
  } catch (e) { return handleDiscordError(e); }
});

server.tool("discord_delete_webhook", "Delete a webhook.", {
  webhookId: z.string().describe("Webhook ID"),
  webhookToken: z.string().optional().describe("Webhook token (for URL-based auth)"),
}, async ({ webhookId, webhookToken }) => {
  try {
    const url = webhookToken ? `/webhooks/${webhookId}/${webhookToken}` : `/webhooks/${webhookId}`;
    await discordFetch(url, { method: "DELETE" });
    return { content: [{ type: "text", text: `Webhook ${webhookId} deleted.` }] };
  } catch (e) { return handleDiscordError(e); }
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[discord-mcp] v3.0.0 started — 22 tools, REST API mode");
}

main().catch((err) => { console.error("[discord-mcp] Fatal:", err); process.exit(1); });
