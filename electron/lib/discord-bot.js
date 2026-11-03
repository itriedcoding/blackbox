/**
 * A Discord bot that answers with the model loaded in this app. Messages are
 * routed through the same engine the window uses, so replies are generated on
 * this CPU with the same system prompt rules and no network hop to a provider.
 */

import { discordActivityText } from "./discord-presence.js";

let discordModule = null;

/** discord.js is loaded on demand, so a missing install cannot stop the app booting. */
async function loadDiscord() {
  if (discordModule) return discordModule;
  try {
    discordModule = await import("discord.js");
    return discordModule;
  } catch (error) {
    throw new Error(
      `discord.js is not installed in this build (${error.message}). Reinstall Blackbox from the release page.`,
    );
  }
}

export const MESSAGE_LIMIT = 1900;

/** A bot token's first segment is base64 of the application id. */
export function appIdFromToken(token) {
  const first = String(token ?? "").trim().split(".")[0];
  if (!first || !/^[A-Za-z0-9_-]+$/.test(first)) return null;
  try {
    const decoded = Buffer.from(first, "base64").toString("utf8");
    return /^\d{17,20}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function maskToken(token) {
  const value = String(token ?? "").trim();
  if (!value) return "";
  if (value.length <= 12) return "•".repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export const INVITE_PERMISSIONS = 84992; // view channels, send messages, embed links, read history

export function inviteUrl(clientId) {
  const id = String(clientId ?? "").trim();
  if (!/^\d{17,20}$/.test(id)) return null;
  const params = new URLSearchParams({
    client_id: id,
    scope: "bot applications.commands",
    permissions: String(INVITE_PERMISSIONS),
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

/** Splits a reply so every message stays inside Discord's 2000-character cap. */
export function chunkMessage(text, limit = MESSAGE_LIMIT) {
  const value = String(text ?? "");
  if (value.length <= limit) return value ? [value] : [];
  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Optional persona appended to the app prompt for bot replies only. */
export function botSystemPrompt(basePrompt, persona) {
  const base = String(basePrompt ?? "").trim();
  const extra = String(persona ?? "").trim();
  if (!extra) return base;
  return `${base}\n\nDiscord context: you are answering in a Discord channel, so keep replies compact and skip preamble. ${extra}`;
}

/** Per-user cooldown so one person cannot pin the CPU. */
export class Cooldown {
  constructor(windowMs = 4000) {
    this.windowMs = windowMs;
    this.seen = new Map();
  }

  allow(key, now = Date.now()) {
    const last = this.seen.get(key);
    // A user who has never spoken is always allowed; only a real previous
    // message can put someone inside the window.
    if (last !== undefined && now - last < this.windowMs) return false;
    this.seen.set(key, now);
    if (this.seen.size > 500) {
      for (const [entry, at] of this.seen) {
        if (now - at > this.windowMs * 4) this.seen.delete(entry);
      }
    }
    return true;
  }

  reset() {
    this.seen.clear();
  }
}

/** Keeps a bounded transcript per channel so replies have context. */
export class ChannelHistory {
  constructor({ turns = 8 } = {}) {
    this.turns = turns;
    this.byChannel = new Map();
  }

  get(channelId) {
    return this.byChannel.get(channelId) ?? [];
  }

  append(channelId, role, content) {
    const items = this.byChannel.get(channelId) ?? [];
    items.push({ role, content: String(content ?? "") });
    while (items.length > this.turns * 2) items.shift();
    this.byChannel.set(channelId, items);
    return items;
  }

  clear(channelId) {
    if (channelId) this.byChannel.delete(channelId);
    else this.byChannel.clear();
  }
}

/** Checks a token against Discord itself, so a typo is caught before login. */
export async function verifyToken(token, { fetchImpl = fetch } = {}) {
  const value = String(token ?? "").trim();
  if (!value) throw new Error("Paste a bot token first.");
  let response;
  try {
    response = await fetchImpl("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${value}` },
    });
  } catch (error) {
    throw new Error(`Could not reach discord.com to check the token: ${error.message}`);
  }
  if (response.status === 401) {
    throw new Error("Discord rejected this token (401 Unauthorized). Reset it in Developer Portal → Bot → Reset Token.");
  }
  if (response.status === 403) {
    throw new Error("Discord accepted the token but refused the request (403). Check the bot is not disabled.");
  }
  if (!response.ok) throw new Error(`Discord answered HTTP ${response.status} while checking the token.`);
  const data = await response.json();
  return {
    id: String(data.id ?? ""),
    username: String(data.username ?? ""),
    globalName: data.global_name ? String(data.global_name) : null,
  };
}

export class DiscordBot {
  constructor({ engine, readSettings, onEvent = () => {} } = {}) {
    this.engine = engine;
    this.readSettings = readSettings;
    this.onEvent = onEvent;
    this.client = null;
    this.cooldown = new Cooldown();
    this.history = new ChannelHistory();
    this.status = { running: false, tag: null, guilds: 0, startedAt: null, lastError: null, replies: 0 };
  }

  getState() {
    return { ...this.status };
  }

  async start({ token, channelId = "", persona = "", maxTokens = 320, cooldownMs = 4000 } = {}) {
    if (this.client) return this.getState();
    const value = String(token ?? "").trim();
    if (!value) throw new Error("Add a bot token first. Discord Developer Portal → your app → Bot → Reset Token.");

    const { Client, GatewayIntentBits, Partials } = await loadDiscord();
    this.cooldown = new Cooldown(Math.max(0, Number(cooldownMs) || 0));

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this.client = client;

    client.on("ready", () => {
      this.status = {
        running: true,
        tag: client.user?.tag ?? null,
        guilds: client.guilds?.cache?.size ?? 0,
        startedAt: Date.now(),
        lastError: null,
        replies: this.status.replies,
      };
      this.onEvent({ type: "status", status: this.getState() });
    });

    client.on("error", (error) => {
      this.status.lastError = error.message;
      this.onEvent({ type: "error", message: error.message });
    });

    client.on("messageCreate", (message) => {
      this.handleMessage(message, { channelId, persona, maxTokens }).catch((error) => {
        this.status.lastError = error.message;
        this.onEvent({ type: "error", message: error.message });
      });
    });

    try {
      await client.login(value);
    } catch (error) {
      this.client = null;
      try {
        await client.destroy();
      } catch {
        /* never logged in */
      }
      const raw = String(error.message ?? error);
      const message = /disallowed intents|privileged/i.test(raw)
        ? "Discord refused the login because the Message Content intent is off. Enable it in Developer Portal → Bot → Privileged Gateway Intents, then start the bot again."
        : /token/i.test(raw)
          ? "Discord rejected the token. Copy it again from the Developer Portal (Bot → Reset Token)."
          : `Discord login failed: ${raw}`;
      this.status = { ...this.status, running: false, lastError: message };
      throw new Error(message);
    }

    return this.getState();
  }

  async stop() {
    if (!this.client) {
      this.status = { ...this.status, running: false };
      return this.getState();
    }
    const client = this.client;
    this.client = null;
    try {
      await client.destroy();
    } catch {
      /* already gone */
    }
    this.status = { ...this.status, running: false, tag: null, guilds: 0, startedAt: null };
    this.history.clear();
    this.onEvent({ type: "status", status: this.getState() });
    return this.getState();
  }

  /** True for DMs, @mentions, and the configured channel only. */
  shouldAnswer(message, channelId) {
    if (!message?.author || message.author.bot) return false;
    if (message.channel?.type === 1) return true; // DM
    if (message.mentions?.users?.has?.(message.client.user.id)) return true;
    if (channelId && message.channelId === channelId) return true;
    return false;
  }

  cleanPrompt(message) {
    let text = String(message.content ?? "");
    if (message.client?.user) {
      text = text.replace(new RegExp(`<@!?${message.client.user.id}>`, "g"), " ");
    }
    return text.trim();
  }

  async handleMessage(message, { channelId = "", persona = "", maxTokens = 320 } = {}) {
    if (!this.shouldAnswer(message, channelId)) return null;

    const prompt = this.cleanPrompt(message);
    if (!prompt) {
      await this.reply(message, "Ask me something after the mention and I will answer with the model running on this machine.");
      return null;
    }

    if (!this.engine.status().loaded) {
      await this.reply(message, "No model is loaded in Blackbox right now. Load one in the app and try again.");
      return null;
    }

    if (!this.cooldown.allow(message.author.id)) {
      this.onEvent({ type: "cooldown", userId: message.author.id });
      return null;
    }

    const settings = this.readSettings ? this.readSettings() : {};
    const systemPrompt = botSystemPrompt(settings.systemPrompt, persona);

    try {
      if (typeof message.channel?.sendTyping === "function") await message.channel.sendTyping();
    } catch {
      /* typing is cosmetic */
    }

    const history = this.history.get(message.channelId);
    let result;
    try {
      result = await this.engine.chat({
        chatId: `discord:${message.channelId}`,
        systemPrompt,
        history,
        prompt,
        temperature: 0.8,
        topP: 0.9,
        maxTokens: Math.min(1024, Math.max(32, Number(maxTokens) || 320)),
      });
    } catch (error) {
      await this.reply(message, `The model failed on this request: ${error.message}`);
      return null;
    }

    const text = String(result?.text ?? "").trim();
    this.history.append(message.channelId, "user", prompt);
    this.history.append(message.channelId, "assistant", text);
    this.status = { ...this.status, replies: this.status.replies + 1 };
    this.onEvent({ type: "reply", channelId: message.channelId, chars: text.length, stats: result?.stats ?? null });

    if (!text) {
      await this.reply(message, "The model returned nothing. Try a shorter prompt.");
      return null;
    }

    for (const chunk of chunkMessage(text)) {
      await this.reply(message, chunk);
    }
    return text;
  }

  async reply(message, text) {
    try {
      if (typeof message.reply === "function") {
        await message.reply({ content: text, allowedMentions: { repliedUser: false } });
      } else {
        await message.channel.send({ content: text, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      this.status.lastError = error.message;
      this.onEvent({ type: "error", message: `Could not send the reply: ${error.message}` });
    }
  }

  /** Text for Discord Rich Presence, from the same engine state the window shows. */
  activity(logoUrl) {
    return discordActivityText({ status: this.engine.status(), logoUrl, botTag: this.status.tag });
  }
}
