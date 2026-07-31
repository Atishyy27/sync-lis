// mehfil core — music-grade WebRTC.
// Call stacks default to voice processing + mono low-bitrate Opus; everything
// here exists to turn that off.

// Opus fmtp declares what *this* agent wants to RECEIVE, so the listener's
// ANSWER is what actually makes the source send stereo/256k. Munge both
// directions so either side of the pipe is covered.
export function mungeOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
  if (!m) return sdp;
  const pt = m[1];
  const params = "stereo=1;sprop-stereo=1;maxaveragebitrate=256000;cbr=0;useinbandfec=1;usedtx=0";
  const fmtpRe = new RegExp(`a=fmtp:${pt} (.*)`);
  if (fmtpRe.test(sdp)) {
    return sdp.replace(fmtpRe, (line, existing) => {
      const kept = existing
        .split(";")
        .filter((kv) => !/^(stereo|sprop-stereo|maxaveragebitrate|cbr|useinbandfec|usedtx)=/.test(kv.trim()));
      return `a=fmtp:${pt} ${[...kept, params].join(";")}`;
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${params}`);
}

// Web app capture: whole-system audio via the screen-share picker.
// video:true is mandatory for getDisplayMedia; caller stops the video track.
export function displayCaptureOptions() {
  return {
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
      suppressLocalAudioPlayback: false,
    },
    systemAudio: "include",
    selfBrowserSurface: "exclude",
    monitorTypeSurfaces: "include",
  };
}

// Extension capture: a single tab's audio via chrome.tabCapture stream ID.
export function tabAudioConstraints(streamId) {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  };
}

// LAN/room peers only ever need host candidates; no STUN.
const PC_CONFIG = { iceServers: [] };

export async function offerFromSource({ track, stream, sendSignal }) {
  const pc = new RTCPeerConnection(PC_CONFIG);
  pc.addTrack(track, stream);
  pc.onicecandidate = (e) => e.candidate && sendSignal({ candidate: e.candidate });
  const offer = await pc.createOffer();
  offer.sdp = mungeOpus(offer.sdp);
  await pc.setLocalDescription(offer);
  sendSignal({ sdp: pc.localDescription });
  return pc;
}

export async function answerAsListener({ offerSdp, sendSignal, onTrack }) {
  const pc = new RTCPeerConnection(PC_CONFIG);
  pc.onicecandidate = (e) => e.candidate && sendSignal({ candidate: e.candidate });
  pc.ontrack = (e) => {
    tuneReceiver(e.receiver);
    onTrack(e.streams[0] || new MediaStream([e.track]));
  };
  await pc.setRemoteDescription(offerSdp);
  const answer = await pc.createAnswer();
  answer.sdp = mungeOpus(answer.sdp);
  await pc.setLocalDescription(answer);
  sendSignal({ sdp: pc.localDescription });
  return pc;
}

// Clean networks don't need the default adaptive jitter buffer; pin it low.
export function tuneReceiver(receiver) {
  try { receiver.jitterBufferTarget = 40; } catch {}
  try { receiver.playoutDelayHint = 0.04; } catch {}
}
