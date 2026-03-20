// ============ VOICE CHAT (WebRTC) ============
class VoiceChat {
  constructor() {
    this.localStream = null;
    this.peers = new Map();
    this.isMuted = true;
    this.isEnabled = false;
    this.socket = null;
    this.playerId = null;
    this.roomPlayers = [];
    this.onSpeakingChange = null;

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  init(socket, playerId) {
    this.socket = socket;
    this.playerId = playerId;

    socket.on('rtc_offer', async (data) => {
      await this.handleOffer(data.from, data.offer);
    });

    socket.on('rtc_answer', async (data) => {
      await this.handleAnswer(data.from, data.answer);
    });

    socket.on('rtc_ice_candidate', async (data) => {
      await this.handleIceCandidate(data.from, data.candidate);
    });
  }

  async startVoice(players) {
    this.roomPlayers = players.filter(p => p.id !== this.playerId);
    this.isEnabled = true;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Start muted
      this.localStream.getAudioTracks().forEach(t => t.enabled = false);
      this.isMuted = true;

      // Create peer connections to all other players
      for (const player of this.roomPlayers) {
        await this.createPeerConnection(player.id, true);
      }
    } catch (err) {
      console.warn('Microphone access denied:', err);
      this.isEnabled = false;
    }
  }

  async createPeerConnection(peerId, isInitiator) {
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(peerId, pc);

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Handle remote stream
    pc.ontrack = (event) => {
      const audio = new Audio();
      audio.srcObject = event.streams[0];
      audio.autoplay = true;
      audio.id = `audio-${peerId}`;
      document.body.appendChild(audio);
    };

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('rtc_ice_candidate', {
          target: peerId,
          candidate: event.candidate
        });
      }
    };

    // If initiator, create offer
    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('rtc_offer', {
          target: peerId,
          offer: offer
        });
      } catch (err) {
        console.error('Error creating offer:', err);
      }
    }

    return pc;
  }

  async handleOffer(fromId, offer) {
    let pc = this.peers.get(fromId);
    if (!pc) {
      pc = await this.createPeerConnection(fromId, false);
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('rtc_answer', {
        target: fromId,
        answer: answer
      });
    } catch (err) {
      console.error('Error handling offer:', err);
    }
  }

  async handleAnswer(fromId, answer) {
    const pc = this.peers.get(fromId);
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('Error handling answer:', err);
      }
    }
  }

  async handleIceCandidate(fromId, candidate) {
    const pc = this.peers.get(fromId);
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    }
  }

  toggleMute() {
    if (!this.localStream) return false;

    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMuted;
    });

    return !this.isMuted;
  }

  stopVoice() {
    this.isEnabled = false;
    this.isMuted = true;

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // Close all peer connections
    this.peers.forEach((pc, id) => {
      pc.close();
      const audio = document.getElementById(`audio-${id}`);
      if (audio) audio.remove();
    });
    this.peers.clear();
  }

  destroy() {
    this.stopVoice();
  }
}

// Global instance
const voiceChat = new VoiceChat();
