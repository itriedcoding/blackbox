#!/usr/bin/env node
/**
 * Real checks for the Discord features, runnable without Electron and without a
 * Discord account:
 *
 *  - token → application id, masking, invite URL
 *  - reply chunking against Discord's 2000-character cap
 *  - per-user cooldown and per-channel history
 *  - the Rich Presence RPC client, against a stand-in socket that speaks
 *    Discord's framing (handshake, SET_ACTIVITY, clear, disconnect)
 *  - token verification against a stubbed HTTP response (401 and 200)
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";

import {
  MESSAGE_LIMIT,
  appIdFromToken,
  maskToken,
  inviteUrl,
  chunkMessage,
  botSystemPrompt,
  Cooldown,
  ChannelHistory,
  verifyToken,
} from "../electron/lib/discord-bot.js";
import {
  DiscordPresence,
  FrameReader,
  encodeFrame,
  sanitizeActivity,
  OP_FRAME,
  OP_HANDSHAKE,
} from "../electron/lib/discord-rpc.js";
import { discordActivityText } from "../electron/lib/discord-presence.js";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.stack ?? error.message}`);
  }
}

const APP_ID = "123456789012345678";
const TOKEN_BODY = Buffer.from(APP_ID).toString("base64url");
const TOKEN = `${TOKEN_BODY}.Gh3xyz.tokenbody`;

console.log("discord checks");

await check("a token's first segment decodes to the application id", () => {
  assert.equal(appIdFromToken(TOKEN), APP_ID);
  assert.equal(appIdFromToken("not-a-token"), null);
  assert.equal(appIdFromToken(""), null);
  assert.equal(appIdFromToken(`${Buffer.from("hello").toString("base64url")}.abc.def`), null);
});

await check("the saved token is masked, never echoed in full", () => {
  const masked = maskToken(TOKEN);
  assert.ok(!masked.includes(TOKEN));
  assert.ok(masked.startsWith(TOKEN.slice(0, 6)));
  assert.ok(masked.endsWith(TOKEN.slice(-4)));
  assert.equal(maskToken("short"), "•".repeat(5));
  assert.equal(maskToken(""), "");
});

await check("the invite url carries the bot scope and the needed permissions", () => {
  const url = inviteUrl(APP_ID);
  const parsed = new URL(url);
  assert.equal(parsed.host, "discord.com");
  assert.equal(parsed.searchParams.get("client_id"), APP_ID);
  assert.equal(parsed.searchParams.get("scope"), "bot applications.commands");
  // view channel + send messages + embed links + read history
  assert.equal(Number(parsed.searchParams.get("permissions")), 84992);
  assert.equal(inviteUrl("nope"), null);
});

await check("replies are split inside Discord's 2000 character cap", () => {
  assert.deepEqual(chunkMessage("hello"), ["hello"]);
  assert.deepEqual(chunkMessage(""), []);
  const long = ("word ".repeat(1200)).trim();
  const chunks = chunkMessage(long);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= MESSAGE_LIMIT, `chunk ${chunk.length} over the cap`);
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
});

await check("a very long single word is still cut, not dropped", () => {
  const chunks = chunkMessage("x".repeat(5000));
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join("").length, 5000);
  for (const chunk of chunks) assert.ok(chunk.length <= MESSAGE_LIMIT);
});

await check("the bot persona is appended, not a replacement", () => {
  assert.equal(botSystemPrompt("base prompt", ""), "base prompt");
  const combined = botSystemPrompt("base prompt", "Answer in lowercase.");
  assert.ok(combined.startsWith("base prompt"));
  assert.ok(combined.includes("Answer in lowercase."));
  assert.ok(combined.includes("Discord"));
});

await check("cooldown blocks a second message inside the window and frees later", () => {
  const cooldown = new Cooldown(4000);
  assert.equal(cooldown.allow("u1", 1_000), true);
  assert.equal(cooldown.allow("u1", 2_000), false);
  assert.equal(cooldown.allow("u2", 2_000), true, "other users are unaffected");
  assert.equal(cooldown.allow("u1", 5_500), true);
});

await check("channel history is bounded and keeps order", () => {
  const history = new ChannelHistory({ turns: 2 });
  history.append("c1", "user", "one");
  history.append("c1", "assistant", "two");
  history.append("c1", "user", "three");
  history.append("c1", "assistant", "four");
  history.append("c1", "user", "five");
  const items = history.get("c1");
  assert.equal(items.length, 4, "two turns means four messages");
  assert.deepEqual(items.at(-1), { role: "user", content: "five" });
  history.clear("c1");
  assert.deepEqual(history.get("c1"), []);
});

await check("activity text follows the engine state", () => {
  const loaded = discordActivityText({
    status: { loaded: true, modelName: "qwen2.5-3b-instruct", contextSize: 4096, gpu: false },
    logoUrl: "https://example.com/logo.png",
  });
  assert.equal(loaded.details, "Running qwen2.5-3b-instruct");
  assert.equal(loaded.state, "4096 token context · CPU");
  assert.equal(loaded.assets.large_image, "https://example.com/logo.png");

  const busy = discordActivityText({ status: { loaded: true, modelName: "m.gguf", busy: true } });
  assert.equal(busy.details, "Generating with m");
  assert.equal(busy.state, "Answering on this CPU");

  const idle = discordActivityText({ status: { loaded: false }, botTag: "blackbox#1234" });
  assert.equal(idle.state, "Bot online as blackbox#1234");
});

await check("activity fields are clamped inside Discord's limits", () => {
  const clean = sanitizeActivity({ details: "  spaced   out  ", state: "x".repeat(300) });
  assert.equal(clean.details, "spaced out");
  assert.ok(clean.state.length <= 128);
  assert.equal(clean.instance, false);
  const fallback = sanitizeActivity({});
  assert.equal(fallback.details, "Blackbox");
  assert.equal(fallback.assets, undefined);
});

await check("frames survive being split across chunks", () => {
  const reader = new FrameReader();
  const frame = encodeFrame(OP_FRAME, { cmd: "PING", nonce: "1" });
  const first = reader.push(frame.subarray(0, 3));
  assert.equal(first.length, 0);
  const rest = reader.push(frame.subarray(3));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].payload.cmd, "PING");
  assert.equal(rest[0].op, OP_FRAME);
});

await check("two frames arriving in one chunk are both read", () => {
  const reader = new FrameReader();
  const both = Buffer.concat([encodeFrame(OP_FRAME, { a: 1 }), encodeFrame(OP_FRAME, { b: 2 })]);
  const frames = reader.push(both);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((frame) => frame.payload), [{ a: 1 }, { b: 2 }]);
});

const socketPath = path.join(os.tmpdir(), `blackbox-discord-${process.pid}.sock`);
let server = null;
const received = [];

await check("discord.js is installed, so the bot can actually log in", async () => {
  const mod = await import("discord.js");
  assert.equal(typeof mod.Client, "function");
  assert.equal(typeof mod.GatewayIntentBits?.MessageContent, "number");
});

await check("presence handshakes, sets activity and clears it over a real socket", async () => {
  if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
  server = net.createServer((socket) => {
    const reader = new FrameReader();
    socket.on("data", (chunk) => {
      for (const frame of reader.push(chunk)) {
        received.push(frame);
        const payload = frame.payload ?? {};
        if (frame.op === OP_HANDSHAKE) {
          socket.write(encodeFrame(OP_FRAME, { cmd: "DISPATCH", evt: "READY", data: { v: 1, config: {} } }));
          continue;
        }
        if (payload.nonce) {
          socket.write(
            encodeFrame(OP_FRAME, { cmd: payload.cmd, data: payload.args?.activity ?? null, nonce: payload.nonce }),
          );
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const presence = new DiscordPresence({
    clientId: APP_ID,
    socketPath,
    logoUrl: "https://raw.githubusercontent.com/itriedcoding/locally-uncensored-ai/main/build/icon.png",
  });
  try {
    const state = await presence.connect();
    assert.equal(state.connected, true);

    const handshake = received.find((frame) => frame.op === OP_HANDSHAKE);
    assert.equal(handshake.payload.client_id, APP_ID);
    assert.equal(handshake.payload.v, 1);

    await presence.setActivity({ details: "Running demo", state: "CPU · 4096 token context" });
    const update = received.filter((frame) => frame.payload?.cmd === "SET_ACTIVITY").at(-1);
    assert.equal(update.payload.args.pid, process.pid);
    assert.equal(update.payload.args.activity.details, "Running demo");
    assert.ok(
      update.payload.args.activity.assets.large_image.startsWith("https://"),
      "the activity must carry the logo url as its large image",
    );

    received.length = 0;
    await presence.clearActivity();
    const cleared = received.filter((frame) => frame.payload?.cmd === "SET_ACTIVITY").at(-1);
    assert.equal(cleared.payload.args.activity, null, "clearing sends a null activity");
  } finally {
    presence.close();
    assert.equal(presence.status.connected, false);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

await check("a missing Discord socket is reported, not hidden", async () => {
  const presence = new DiscordPresence({ clientId: APP_ID, socketPath: path.join(os.tmpdir(), "no-discord-here.sock") });
  await assert.rejects(() => presence.connect(), /Could not reach the Discord client|Discord did not answer/);
  assert.equal(presence.status.connected, false);
});

await check("a rejected token surfaces Discord's 401 wording", async () => {
  await assert.rejects(
    () => verifyToken("bad", { fetchImpl: async () => ({ ok: false, status: 401 }) }),
    /rejected this token \(401/,
  );
  await assert.rejects(() => verifyToken("", { fetchImpl: async () => ({ ok: true, status: 200 }) }), /Paste a bot token/);
});

await check("a valid token returns the bot identity", async () => {
  const me = await verifyToken("good", {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://discord.com/api/v10/users/@me");
      assert.equal(options.headers.Authorization, "Bot good");
      return { ok: true, status: 200, json: async () => ({ id: APP_ID, username: "blackbox", global_name: "Blackbox" }) };
    },
  });
  assert.deepEqual(me, { id: APP_ID, username: "blackbox", globalName: "Blackbox" });
});

if (server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });

console.log(`\n${passed}/${passed + failed} discord checks passed`);
process.exit(failed === 0 ? 0 : 1);
