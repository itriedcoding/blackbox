/**
 * Activity text shared by the bot and the presence client. Kept separate from
 * both so the strings can be tested without a socket or a Discord login.
 */

export function discordActivityText({ status = {}, logoUrl = "", botTag = null } = {}) {
  const model = status.modelName ? String(status.modelName).replace(/\.gguf$/i, "") : null;
  const details = status.busy
    ? model
      ? `Generating with ${model}`
      : "Generating on this machine"
    : model
      ? `Running ${model}`
      : "Blackbox · local AI";

  const state = status.busy
    ? "Answering on this CPU"
    : model
      ? `${status.contextSize ? `${status.contextSize} token context` : "loaded"} · ${status.gpu ? `${status.gpu} + CPU` : "CPU"}`
      : botTag
        ? `Bot online as ${botTag}`
        : "No model loaded";

  const activity = { details, state };
  if (logoUrl) activity.assets = { large_image: String(logoUrl), large_text: "Blackbox · local, uncensored AI" };
  return activity;
}
