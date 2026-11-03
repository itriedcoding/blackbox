/**
 * IPC surface for Discord: the bot that answers with the local model, and Rich
 * Presence showing what is loaded. Kept out of main.js like the studio features.
 */

import { app, ipcMain } from "electron";
import * as store from "./store.js";
import * as engine from "./engine.js";
import { DiscordBot, appIdFromToken, inviteUrl, maskToken, verifyToken } from "./discord-bot.js";
import { DiscordPresence } from "./discord-rpc.js";
import { discordActivityText } from "./discord-presence.js";

export function registerDiscord({ send }) {
  const bot = new DiscordBot({
    engine,
    readSettings: () => store.readSettings(),
    onEvent: (payload) => send("discord:event", payload),
  });

  let presence = null;
  let presenceEnabled = false;
  let activityTimer = null;

  function presenceState() {
    return presence ? presence.status : { connected: false, clientId: null, socket: null, lastError: null, since: null };
  }

  function botOptions() {
    const settings = store.readSettings();
    return {
      token: settings.discordToken || "",
      channelId: settings.discordChannelId || "",
      persona: settings.discordPersona || "",
      maxTokens: settings.discordMaxTokens,
      cooldownMs: settings.discordCooldownMs,
    };
  }

  function statusPayload() {
    const settings = store.readSettings();
    return {
      bot: bot.getState(),
      presence: {
        ...presenceState(),
        enabled: presenceEnabled,
        appId: settings.discordAppId || appIdFromToken(settings.discordToken) || null,
        logoUrl: settings.discordLogoUrl || "",
      },
      settings: {
        tokenSet: Boolean(settings.discordToken),
        tokenHint: maskToken(settings.discordToken),
        channelId: settings.discordChannelId || "",
        appId: settings.discordAppId || "",
        logoUrl: settings.discordLogoUrl || "",
        startWithApp: Boolean(settings.discordStartWithApp),
        presenceOnLaunch: Boolean(settings.discordPresenceOnLaunch),
      },
    };
  }

  async function pushActivity() {
    if (!presence || !presence.connected) return null;
    const settings = store.readSettings();
    const activity = discordActivityText({
      status: engine.status(),
      logoUrl: settings.discordLogoUrl,
      botTag: bot.getState().tag,
    });
    try {
      await presence.setActivity(activity);
      return activity;
    } catch (error) {
      send("discord:event", { type: "error", message: error.message });
      return null;
    }
  }

  async function startPresence(request = {}) {
    const settings = store.readSettings();
    const clientId = String(
      request.appId ?? settings.discordAppId ?? appIdFromToken(settings.discordToken) ?? "",
    ).trim();
    if (!/^\d{17,20}$/.test(clientId)) {
      throw new Error(
        "Rich Presence needs a Discord application ID. Paste it from Developer Portal → General Information → Application ID.",
      );
    }
    if (presence) {
      presence.close();
      presence = null;
    }
    presence = new DiscordPresence({
      clientId,
      logoUrl: settings.discordLogoUrl,
      onState: (state) => send("discord:event", { type: "presence", state }),
    });
    await presence.connect();
    presenceEnabled = true;
    await pushActivity();
    if (!activityTimer) {
      // The window's own state changes constantly; a 15s refresh keeps the
      // profile honest without hammering Discord with updates.
      activityTimer = setInterval(() => {
        pushActivity();
      }, 15000);
    }
    send("discord:event", { type: "presence", state: presence.status });
    return presence.status;
  }

  async function stopPresence() {
    presenceEnabled = false;
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
    if (presence) {
      try {
        await presence.clearActivity();
      } catch {
        /* the client may already be gone */
      }
      presence.close();
      presence = null;
    }
    return presenceState();
  }

  ipcMain.handle("discord:status", () => statusPayload());

  ipcMain.handle("discord:test", async (_event, token) => {
    const stored = store.readSettings().discordToken;
    return verifyToken(token || stored);
  });

  ipcMain.handle("discord:start", async () => {
    const options = botOptions();
    if (!options.token) throw new Error("Add a bot token in Settings → Discord first.");
    const state = await bot.start(options);
    await pushActivity();
    return state;
  });

  ipcMain.handle("discord:stop", async () => {
    const state = await bot.stop();
    await pushActivity();
    return state;
  });

  ipcMain.handle("discord:invite", () => {
    const settings = store.readSettings();
    return inviteUrl(settings.discordAppId || appIdFromToken(settings.discordToken));
  });

  ipcMain.handle("discord:presence-start", (event, request = {}) => startPresence(request));
  ipcMain.handle("discord:presence-stop", () => stopPresence());
  ipcMain.handle("discord:activity", async () => {
    const activity = await pushActivity();
    return { activity, presence: presenceState() };
  });

  const settings = store.readSettings();
  if (settings.discordStartWithApp && settings.discordToken) {
    bot.start(botOptions()).catch((error) => {
      send("discord:event", { type: "error", message: error.message });
    });
  }
  if (settings.discordPresenceOnLaunch) {
    startPresence().catch((error) => {
      send("discord:event", { type: "error", message: error.message });
    });
  }

  const shutdown = () => {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = null;
    presenceEnabled = false;
    if (presence) presence.close();
    presence = null;
    bot.stop().catch(() => {});
  };
  app.on("will-quit", shutdown);
  return { bot, status: statusPayload, stop: shutdown };
}
