/**
 * Storage for the one secret this app holds: the AI Gateway key.
 *
 * On Windows and macOS Electron's safeStorage encrypts it with the OS keychain /
 * DPAPI, so the settings file never contains the raw key. On the rare machine
 * where that is unavailable the key is still kept out of the renderer, but it is
 * only obfuscated on disk — the UI says so instead of pretending otherwise.
 *
 * `safeStorage` is a parameter rather than an import so the round trip can be
 * exercised outside Electron.
 */

export const KEY_FIELD = "gatewayApiKey";

const ENCRYPTED = "enc:v1:";
const PLAIN = "plain:v1:";

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

export function keyHint(key) {
  const value = normalize(key);
  if (!value) return "";
  return `••••${value.slice(-4)}`;
}

/** Seals a key for settings.json. Returns the fields to persist. */
export function sealSecret(value, safeStorage) {
  const key = normalize(value);
  if (!key) return { [KEY_FIELD]: "", gatewayKeyHint: "", gatewayKeyEncrypted: false };

  const canEncrypt = Boolean(safeStorage && safeStorage.isEncryptionAvailable?.());
  if (canEncrypt) {
    try {
      const encrypted = safeStorage.encryptString(key);
      return {
        [KEY_FIELD]: ENCRYPTED + Buffer.from(encrypted).toString("base64"),
        gatewayKeyHint: keyHint(key),
        gatewayKeyEncrypted: true,
      };
    } catch {
      /* fall through to the plain form rather than losing the key */
    }
  }
  return {
    [KEY_FIELD]: PLAIN + Buffer.from(key, "utf8").toString("base64"),
    gatewayKeyHint: keyHint(key),
    gatewayKeyEncrypted: false,
  };
}

/** Reverses sealSecret. Returns "" when nothing usable is stored. */
export function openSecret(stored, safeStorage) {
  const value = String(stored ?? "").trim();
  if (!value) return "";

  if (value.startsWith(ENCRYPTED)) {
    if (!safeStorage?.decryptString) return "";
    try {
      const buffer = Buffer.from(value.slice(ENCRYPTED.length), "base64");
      return normalize(safeStorage.decryptString(buffer));
    } catch {
      // A key sealed by another machine or OS account cannot be opened here.
      return "";
    }
  }

  if (value.startsWith(PLAIN)) {
    try {
      return normalize(Buffer.from(value.slice(PLAIN.length), "base64").toString("utf8"));
    } catch {
      return "";
    }
  }

  // Older/hand-written settings may hold the key directly.
  return normalize(value);
}

/** What the renderer is allowed to see: never the key itself. */
export function redactSettings(settings) {
  const { [KEY_FIELD]: stored, ...rest } = settings ?? {};
  return {
    ...rest,
    gatewayKeySet: Boolean(String(stored ?? "").trim()),
    gatewayKeyHint: rest.gatewayKeyHint ?? "",
  };
}
