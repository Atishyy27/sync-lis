// sync-lis voice. Talking while you watch.
//
// This lives in an offscreen document because a service worker can neither hold
// a microphone nor play sound, and a content script would have to ask for the
// microphone in the website's name (which strict sites refuse outright).
//
// The audio never touches our server; it goes straight between the two people.
// The server only carries the handshake.

"use strict";

let mic = null;                 // our own microphone
const peers = new Map();        // memberId -> RTCPeerConnection
const players = new Map();      // memberId -> <audio> for their voice
let muted = false;

// Voice is a conversation, not music: keep the call-quality processing that
// makes a room sound clean, which is exactly what we strip out for music.
const MIC_WANTED = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

const PC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function toSw(msg) {
  chrome.runtime.sendMessage({ target: "sw-voice", ...msg }).catch(() => {});
}

async function ensureMic() {
  if (mic) return mic;
  mic = await navigator.mediaDevices.getUserMedia(MIC_WANTED);
  mic.getAudioTracks().forEach((t) => (t.enabled = !muted));
  return mic;
}

// ---------- is anyone actually talking right now ----------
//
// Watching the incoming peer streams rather than our own mic: the point is to
// duck the *video* when the other person speaks, and their voice is the thing
// competing with it. Our own mic would duck the film every time you breathed
// on it.
//
// One shared AudioContext, one analyser per peer. The analyser only reads the
// stream; the audio you hear still comes from the <audio> element, so tapping
// it here changes nothing about playback.
let actx = null;
const meters = new Map(); // peerId -> { src, analyser, buf }
let speakingNow = false;
let quietSince = 0;
let meterTimer = null;

const SPEAK_ON = 0.035;   // RMS above this counts as speech, not room tone
const SPEAK_OFF = 0.018;  // fall below this to stop: hysteresis, so a pause
                          // between words does not flap the video volume
const HANG_MS = 700;      // and stay ducked this long after they stop

function meterFor(peerId, stream) {
  try {
    actx = actx || new AudioContext();
    if (actx.state === "suspended") actx.resume().catch(() => {});
    const src = actx.createMediaStreamSource(stream);
    const analyser = actx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser); // analyser is a sink here, never connected to output
    meters.set(peerId, { src, analyser, buf: new Float32Array(analyser.fftSize) });
    startMetering();
  } catch {}
}

function rmsOf(m) {
  m.analyser.getFloatTimeDomainData(m.buf);
  let sum = 0;
  for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
  return Math.sqrt(sum / m.buf.length);
}

function startMetering() {
  if (meterTimer) return;
  meterTimer = setInterval(() => {
    if (!meters.size) return;
    let peak = 0;
    for (const m of meters.values()) peak = Math.max(peak, rmsOf(m));
    const now = Date.now();
    if (peak >= SPEAK_ON) {
      quietSince = 0;
      if (!speakingNow) { speakingNow = true; toSw({ type: "speaking", on: true }); }
    } else if (peak < SPEAK_OFF && speakingNow) {
      if (!quietSince) quietSince = now;
      if (now - quietSince >= HANG_MS) {
        speakingNow = false;
        quietSince = 0;
        toSw({ type: "speaking", on: false });
      }
    }
  }, 120);
}

function stopMetering(all) {
  if (!all && meters.size) return;
  clearInterval(meterTimer);
  meterTimer = null;
  if (speakingNow) { speakingNow = false; toSw({ type: "speaking", on: false }); }
}

function play(peerId, stream) {
  let el = players.get(peerId);
  if (!el) {
    el = new Audio();
    el.autoplay = true;
    players.set(peerId, el);
  }
  el.srcObject = stream;
  el.play().catch(() => {});
  meterFor(peerId, stream);
}

function newPeer(peerId) {
  const pc = new RTCPeerConnection(PC_CONFIG);
  peers.set(peerId, pc);
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  pc.onicecandidate = (e) => {
    if (e.candidate) toSw({ type: "signal", to: peerId, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => play(peerId, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) drop(peerId);
  };
  return pc;
}

function drop(peerId) {
  const pc = peers.get(peerId);
  if (pc) pc.close();
  peers.delete(peerId);
  const el = players.get(peerId);
  if (el) {
    el.srcObject = null;
    players.delete(peerId);
  }
  const m = meters.get(peerId);
  if (m) { try { m.src.disconnect(); } catch {} meters.delete(peerId); }
  // the last peer leaving must un-duck, or the video stays quiet forever
  stopMetering(meters.size === 0);
}

async function callPeer(peerId) {
  if (peers.has(peerId)) return;
  await ensureMic();
  const pc = newPeer(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  toSw({ type: "signal", to: peerId, data: { sdp: pc.localDescription } });
}

async function onSignal(from, data) {
  if (data.sdp && data.sdp.type === "offer") {
    await ensureMic();
    drop(from); // a fresh offer replaces any half-open attempt
    const pc = newPeer(from);
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    toSw({ type: "signal", to: from, data: { sdp: pc.localDescription } });
    return;
  }
  if (data.sdp && data.sdp.type === "answer") {
    const pc = peers.get(from);
    if (pc) await pc.setRemoteDescription(data.sdp);
    return;
  }
  if (data.candidate) {
    const pc = peers.get(from);
    if (pc) await pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

function hangUp() {
  for (const id of [...peers.keys()]) drop(id);
  if (mic) mic.getTracks().forEach((t) => t.stop());
  mic = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "voice") return;

  if (msg.type === "join") {
    // we are the newcomer: call everyone already talking
    ensureMic()
      .then(async () => {
        for (const id of msg.peers) await callPeer(id);
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ error: String(e && e.name || e) }));
    return true; // async
  }
  if (msg.type === "signal") {
    onSignal(msg.from, msg.data);
    return;
  }
  if (msg.type === "mute") {
    muted = !!msg.muted;
    if (mic) mic.getAudioTracks().forEach((t) => (t.enabled = !muted));
    return;
  }
  if (msg.type === "peerLeft") {
    drop(msg.peerId);
    return;
  }
  if (msg.type === "leave") {
    hangUp();
    return;
  }
  if (msg.type === "call") {
    // someone already in the room just turned voice on; if we are already
    // talking, dial them too rather than waiting for them to notice us.
    // Covers the case where two people enable voice within the same
    // broadcast window and neither's "call everyone already on" snapshot
    // includes the other.
    if (mic) callPeer(msg.peerId);
    return;
  }
  if (msg.type === "status") {
    sendResponse({
      hasMic: !!mic,
      peers: [...peers.entries()].map(([id, pc]) => ({ id, state: pc.connectionState })),
    });
    return; // sync response
  }
});
