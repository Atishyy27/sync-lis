// mehfil core — the jam session engine.
// Owns the protocol client and all peer connections. Capture is injected:
// the caller obtains a MediaStream however its environment allows
// (getDisplayMedia in a page, tabCapture in an extension) and hands it to
// startSource(). Everything else — rotating source, fan-out, teardown — is here.

import { JamClient } from "./protocol.js";
import { offerFromSource, answerAsListener } from "./rtc.js";

export class JamSession {
  #client = new JamClient();
  #sourcePcs = new Map(); // peerId -> RTCPeerConnection (while we are the source)
  #listenPc = null;
  #listenPeerId = null;
  #sourceStream = null;
  #sourceTrack = null;
  #cb;

  // cb: { onState, onYourTurn, onStream, onStreamEnd, onSourcingStopped, onClose }
  constructor(cb = {}) {
    this.#cb = cb;
    this.#client
      .on("state", (s) => cb.onState && cb.onState(s))
      .on("yourTurn", (m) => cb.onYourTurn && cb.onYourTurn(m.entry))
      .on("peerNeedsOffer", (m) => this.#offerTo(m.peerId))
      .on("stopSourcing", () => this.stopSource(false))
      .on("trackOver", () => this.#teardownListening())
      .on("signal", (m) => this.#onSignal(m.from, m.data))
      .on("close", () => cb.onClose && cb.onClose());
  }

  connect({ url, room, name }) {
    this.#client.connect({ url, room, name });
  }

  // ---- sourcing ----

  // stream: captured MediaStream containing the audio to broadcast.
  // Returns false if there is no audio track (e.g. user forgot the checkbox).
  startSource(stream) {
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    this.#sourceStream = stream;
    this.#sourceTrack = track;
    track.onended = () => this.stopSource(true); // user hit "Stop sharing"
    this.#client.goLive();
    return true;
  }

  stopSource(tellServer = true) {
    if (this.#sourceStream) this.#sourceStream.getTracks().forEach((t) => t.stop());
    this.#sourceStream = null;
    this.#sourceTrack = null;
    for (const pc of this.#sourcePcs.values()) pc.close();
    this.#sourcePcs.clear();
    if (tellServer) this.#client.endTrack();
    if (this.#cb.onSourcingStopped) this.#cb.onSourcingStopped();
  }

  async #offerTo(peerId) {
    if (!this.#sourceTrack) return;
    const pc = await offerFromSource({
      track: this.#sourceTrack,
      stream: this.#sourceStream,
      sendSignal: (data) => this.#client.signal(peerId, data),
    });
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        pc.close();
        this.#sourcePcs.delete(peerId);
      }
    };
    this.#sourcePcs.set(peerId, pc);
  }

  // ---- listening ----

  async #onSignal(from, data) {
    if (data.sdp && data.sdp.type === "offer") {
      this.#teardownListening();
      this.#listenPeerId = from;
      this.#listenPc = await answerAsListener({
        offerSdp: data.sdp,
        sendSignal: (d) => this.#client.signal(from, d),
        onTrack: (stream) => this.#cb.onStream && this.#cb.onStream(stream),
      });
      return;
    }
    if (data.sdp && data.sdp.type === "answer") {
      const pc = this.#sourcePcs.get(from);
      if (pc) await pc.setRemoteDescription(data.sdp);
      return;
    }
    if (data.candidate) {
      const pc = this.#sourcePcs.get(from) || (this.#listenPeerId === from ? this.#listenPc : null);
      if (pc) await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  #teardownListening() {
    if (this.#listenPc) this.#listenPc.close();
    this.#listenPc = null;
    this.#listenPeerId = null;
    if (this.#cb.onStreamEnd) this.#cb.onStreamEnd();
  }

  // ---- passthrough ----

  addTrack(title, platform = "other") { this.#client.addTrack(title, platform); }
  removeTrack(entryId) { this.#client.removeTrack(entryId); }
  voteSkip() { this.#client.voteSkip(); }

  close() {
    this.stopSource(false);
    this.#teardownListening();
    this.#client.close();
  }

  get id() { return this.#client.id; }
  get state() { return this.#client.state; }
  get connected() { return this.#client.connected; }
  get isSourcing() { return !!this.#sourceTrack; }
}
