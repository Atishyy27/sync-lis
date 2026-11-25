// A fake Durable Object runtime, just enough for worker/src/SyncRelay.js:
// storage with structured-clone semantics (like the real thing, so a missed
// saveRoom shows up as lost state), alarms, and hibernation-style sockets.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register("./hooks.mjs", import.meta.url);

const ROOT = path.join(import.meta.dirname, "..", "..");
// SYNCLIS_WORKER_DIR points at another copy of worker/src (the CI "before" screenshots
// run the relay as it was on master); the path must still contain worker/src.
const WORKER_DIR = process.env.SYNCLIS_WORKER_DIR || path.join(ROOT, "worker", "src");
const workerUrl = (f) => pathToFileURL(path.join(WORKER_DIR, f)).href;

export class FakeStorage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(k) { return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined; }
  async put(k, v) { this.map.set(k, structuredClone(v)); }
  async delete(k) { return this.map.delete(k); }
  async list({ prefix = "" } = {}) {
    const out = new Map();
    for (const k of [...this.map.keys()].sort()) if (k.startsWith(prefix)) out.set(k, structuredClone(this.map.get(k)));
    return out;
  }
  async setAlarm(t) { this.alarm = t; }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm = null; }
}

export class FakeSocket {
  constructor() { this.attachment = null; this.closed = false; this.sent = []; }
  serializeAttachment(v) { this.attachment = structuredClone(v); }
  deserializeAttachment() { return this.attachment == null ? null : structuredClone(this.attachment); }
  send(s) { if (this.closed) throw new Error("socket closed"); this.sent.push(s); }
  close() { this.closed = true; }
}

export class FakeState {
  constructor() { this.storage = new FakeStorage(); this.sockets = new Set(); }
  acceptWebSocket(ws) { this.sockets.add(ws); }
  getWebSockets() { return [...this.sockets].filter((w) => !w.closed); }
  blockConcurrencyWhile(fn) { return fn(); }
}

export async function createRelay() {
  const { SyncRelay } = await import(workerUrl("SyncRelay.js"));
  const state = new FakeState();
  const relay = new SyncRelay(state, {});
  // what the platform does when the alarm is due: clear it, then call alarm()
  const fireAlarmIfDue = async () => {
    if (state.storage.alarm == null || Date.now() < state.storage.alarm) return false;
    state.storage.alarm = null;
    await relay.alarm();
    return true;
  };
  return { relay, state, fireAlarmIfDue };
}

export const loadWorkerIndex = () => import(workerUrl("index.js"));
