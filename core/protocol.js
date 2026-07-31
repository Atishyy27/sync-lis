// mehfil core — signaling protocol client.
// Environment-agnostic: works in a web page, an extension offscreen document,
// or anywhere with a WebSocket implementation.

export class JamClient {
  #ws = null;
  #handlers = new Map();

  id = null;
  state = null;

  on(type, fn) {
    this.#handlers.set(type, fn);
    return this;
  }

  #emit(type, msg) {
    const fn = this.#handlers.get(type);
    if (fn) fn(msg);
  }

  connect({ url, room, name }) {
    this.#ws = new WebSocket(url);
    this.#ws.onopen = () => this.#send({ type: "join", room, name });
    this.#ws.onclose = () => this.#emit("close");
    this.#ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "welcome") this.id = msg.id;
      if (msg.type === "state") this.state = msg;
      this.#emit(msg.type, msg);
    };
  }

  #send(obj) {
    if (this.#ws && this.#ws.readyState === 1) this.#ws.send(JSON.stringify(obj));
  }

  addTrack(title, platform = "other") {
    this.#send({ type: "queueAdd", title, platform });
  }
  removeTrack(entryId) {
    this.#send({ type: "queueRemove", entryId });
  }
  goLive() {
    this.#send({ type: "live" });
  }
  endTrack() {
    this.#send({ type: "trackEnded" });
  }
  voteSkip() {
    this.#send({ type: "voteSkip" });
  }
  signal(to, data) {
    this.#send({ type: "signal", to, data });
  }

  close() {
    if (this.#ws) this.#ws.close();
    this.#ws = null;
  }

  get connected() {
    return !!this.#ws && this.#ws.readyState === 1;
  }
}
