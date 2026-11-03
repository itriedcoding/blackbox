/**
 * A real shell, spawned as a child process and streamed to xterm.js.
 *
 * This uses pipes rather than a pseudo-terminal, so line-oriented programs
 * (npm, git, node, python scripts, cargo) behave normally while full-screen
 * TUI programs that probe for a tty will complain. That trade-off is deliberate:
 * a pty needs a native addon rebuilt against Electron's ABI, and this app must
 * keep installing from a plain `npm ci` on Windows.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const SENSITIVE_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)/i;
const MAX_SESSIONS = 4;

/** The child shell inherits the user's environment minus anything credential-shaped. */
export function sanitizedEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SENSITIVE_KEY.test(key)) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.FORCE_COLOR = "1";
  return env;
}

export function defaultShell() {
  if (process.platform === "win32") {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/Q", "/K", "chcp 65001>nul"] };
  }
  const candidate = process.env.SHELL;
  const command = candidate && fs.existsSync(candidate) ? candidate : "/bin/sh";
  return { command, args: ["-i"] };
}

export class ShellSession {
  constructor({ id, cwd, onData, onExit, env, shell }) {
    this.id = id;
    this.cwd = cwd;
    this.onData = onData;
    this.onExit = onExit;
    this.env = env;
    this.shell = shell;
    this.child = null;
    this.decoder = new StringDecoder("utf8");
    this.exited = false;
    this.startedAt = Date.now();
    this.bytes = 0;
  }

  start() {
    const spec = this.shell ?? defaultShell();
    this.child = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const push = (stream) => (chunk) => {
      this.bytes += chunk.length;
      const text = this.decoder.write(chunk);
      if (text) this.onData({ id: this.id, stream, data: text });
    };

    this.child.stdout.on("data", push("stdout"));
    this.child.stderr.on("data", push("stderr"));

    this.child.on("error", (error) => {
      this.onData({ id: this.id, stream: "stderr", data: `\r\n[shell error] ${error.message}\r\n` });
      this.finish(null);
    });

    this.child.on("exit", (code, signal) => {
      const tail = this.decoder.end();
      if (tail) this.onData({ id: this.id, stream: "stdout", data: tail });
      this.finish(code, signal);
    });

    return { id: this.id, pid: this.child.pid ?? null, shell: spec.command, cwd: this.cwd };
  }

  finish(code, signal = null) {
    if (this.exited) return;
    this.exited = true;
    const summary = signal ? `signal ${signal}` : `exit ${code}`;
    this.onData({ id: this.id, stream: "system", data: `\r\n[process ended: ${summary}]\r\n` });
    this.onExit({ id: this.id, code, signal });
  }

  write(data) {
    if (!this.child || this.exited || !this.child.stdin.writable) return false;
    this.child.stdin.write(String(data));
    return true;
  }

  /** No pty means no window size to report; kept so the renderer can call it. */
  resize() {
    return false;
  }

  kill() {
    if (!this.child || this.exited) return false;
    const pid = this.child.pid;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(-pid, "SIGKILL");
      }
      return true;
    } catch {
      try {
        this.child.kill("SIGKILL");
        return true;
      } catch {
        return false;
      }
    }
  }
}

export class ShellManager {
  constructor({ onData = () => {}, onExit = () => {} } = {}) {
    this.sessions = new Map();
    this.counter = 0;
    this.onData = onData;
    this.onExit = onExit;
  }

  start({ cwd, shell } = {}) {
    if (!cwd) throw new Error("A terminal needs a folder.");
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`That folder no longer exists: ${cwd}`);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Close a terminal first (${MAX_SESSIONS} running is the limit).`);
    }
    this.counter += 1;
    const id = `term-${this.counter}`;
    const session = new ShellSession({ id, cwd, shell, env: sanitizedEnv(), onData: this.onData, onExit: this.onExit });
    this.sessions.set(id, session);
    const info = session.start();
    return info;
  }

  write(id, data) {
    const session = this.sessions.get(String(id));
    if (!session) return false;
    return session.write(data);
  }

  resize(id) {
    const session = this.sessions.get(String(id));
    if (!session) return false;
    return session.resize();
  }

  kill(id) {
    const session = this.sessions.get(String(id));
    if (!session) return false;
    const killed = session.kill();
    if (!killed) this.sessions.delete(String(id));
    return killed;
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      cwd: session.cwd,
      exited: session.exited,
      bytes: session.bytes,
      startedAt: session.startedAt,
    }));
  }

  disposeAll() {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}
