// webrtc-mesh.ts — browser WebRTC full-mesh manager for Tellus 3D P2P video.
//
// Self-contained: imports NOTHING from the app (no three.js, no React). Relies
// only on DOM / WebRTC ambient types (RTCPeerConnection, MediaStream, etc. —
// provided by the "DOM" lib in tsconfig).
//
// Design highlights:
//  - One RTCPeerConnection per other peer (full mesh).
//  - Perfect negotiation (makingOffer / ignoreOffer / rollback) so simultaneous
//    offers from both sides never deadlock. Deterministic roles from selfId.
//  - RX default ON, TX default OFF. Each PC carries a single video transceiver
//    (recvonly when TX off, sendrecv when TX on). TX toggling uses replaceTrack
//    on existing senders to avoid renegotiation churn.
//  - RX cap (maxPeers, default 16): beyond the cap we keep the PC but do not
//    surface the remote stream.
//  - Bulletproof error containment: every async boundary is wrapped so a failure
//    on one peer degrades only that peer (its video goes null) and never throws
//    out of the class into the caller's render loop.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PeerStat {
  id: string;
  state: RTCPeerConnectionState;
  haveRemoteVideo: boolean;
  kbps: number;
}

export interface MeshStats {
  peers: PeerStat[];
  rxStreams: number; // number of peers whose remote video is currently surfaced
  tx: boolean; // are we currently sending local video?
  rx: boolean; // are we currently accepting inbound remote video?
}

export interface WebRtcMeshOptions {
  /** This client's stable visitorId. */
  selfId: string;
  /** ICE servers (from world.snapshot.iceServers; default public STUN). */
  iceServers: RTCIceServer[];
  /** Send a 'signal' action over the world WS. `to === null` => broadcast (unused here). */
  sendSignal: (to: string | null, kind: string, payload: string) => void;
  /** Attach (stream) / detach (null) a peer's remote video. */
  onPeerStream: (peerId: string, stream: MediaStream | null) => void;
  /** Optional error sink. peerId === null for non-peer-scoped failures. */
  onError?: (peerId: string | null, err: unknown) => void;
  /** Called ~1Hz while there are peers. */
  onStats?: (stats: MeshStats) => void;
  /** Received-video cap. Default 16. */
  maxPeers?: number;
}

// ---------------------------------------------------------------------------
// Internal per-peer record
// ---------------------------------------------------------------------------

interface PeerRecord {
  id: string;
  pc: RTCPeerConnection;
  /** This side is the impolite offerer (selfId < peerId). */
  polite: boolean;
  /** Perfect-negotiation flags. */
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** The single video transceiver we manage for send/recv direction. */
  videoTransceiver: RTCRtpTransceiver | null;
  /** Latest remote stream observed via ontrack. */
  remoteStream: MediaStream | null;
  /** Whether we've surfaced this peer's stream to the caller (subject to RX + cap). */
  surfaced: boolean;
  /** Stats accounting. */
  lastBytes: number;
  lastStatsTs: number;
  kbps: number;
}

// ---------------------------------------------------------------------------
// Helper: enumerate media devices (defensive, never throws)
// ---------------------------------------------------------------------------

export async function enumerateMediaDevices(): Promise<{
  audioIn: MediaDeviceInfo[];
  videoIn: MediaDeviceInfo[];
}> {
  try {
    const md = navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== "function") {
      return { audioIn: [], videoIn: [] };
    }
    const devices = await md.enumerateDevices();
    return {
      audioIn: devices.filter((d) => d.kind === "audioinput"),
      videoIn: devices.filter((d) => d.kind === "videoinput"),
    };
  } catch {
    return { audioIn: [], videoIn: [] };
  }
}

// ---------------------------------------------------------------------------
// WebRtcMesh
// ---------------------------------------------------------------------------

export class WebRtcMesh {
  private readonly selfId: string;
  private readonly iceServers: RTCIceServer[];
  private readonly sendSignal: WebRtcMeshOptions["sendSignal"];
  private readonly onPeerStream: WebRtcMeshOptions["onPeerStream"];
  private readonly onError?: WebRtcMeshOptions["onError"];
  private readonly onStats?: WebRtcMeshOptions["onStats"];
  private readonly maxPeers: number;

  /** Current peer roster (from setPresence/handleSignal validation), excludes self. */
  private roster = new Set<string>();
  /** Active peer connections. */
  private peers = new Map<string, PeerRecord>();

  private rx = true; // accept inbound remote video
  private tx = false; // send local video

  /** Selected devices for the local capture (audio is unused in v1). */
  private audioDeviceId: string | undefined;
  private videoDeviceId: string | undefined;

  /** Shared local capture stream (video only) while TX is on. */
  private localStream: MediaStream | null = null;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  /** Cached stats snapshot for synchronous getStats(). */
  private cachedStats: MeshStats = { peers: [], rxStreams: 0, tx: false, rx: true };

  constructor(opts: WebRtcMeshOptions) {
    this.selfId = opts.selfId;
    this.iceServers = opts.iceServers ?? [];
    this.sendSignal = opts.sendSignal;
    this.onPeerStream = opts.onPeerStream;
    this.onError = opts.onError;
    this.onStats = opts.onStats;
    this.maxPeers = opts.maxPeers ?? 16;
    this.refreshCachedStats();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Reconcile to the world's current peer roster (excluding self). */
  setPresence(peerIds: string[]): void {
    if (this.destroyed) return;
    const next = new Set<string>();
    for (const id of peerIds) {
      if (id && id !== this.selfId) next.add(id);
    }
    this.roster = next;

    // Tear down PCs for peers that left.
    for (const id of Array.from(this.peers.keys())) {
      if (!next.has(id)) this.removePeer(id);
    }

    // Create connections to new peers (offerer rule decides who initiates).
    for (const id of next) {
      if (!this.peers.has(id)) {
        const rec = this.ensurePeer(id);
        // The impolite side (we're the offerer) kicks off negotiation by adding
        // the transceiver, which triggers onnegotiationneeded. The polite side
        // waits for the offer.
        if (rec && this.isOfferer(id)) {
          // ensurePeer already created the transceiver; negotiationneeded fires.
          // Nothing else required here.
        }
      }
    }

    this.ensureStatsTimer();
    this.refreshCachedStats();
  }

  /** Inbound 'signal' patch from the WS. */
  handleSignal(from: string, kind: string, payload: string): void {
    if (this.destroyed) return;
    // Ignore signals from peers not in the current roster.
    if (!from || from === this.selfId || !this.roster.has(from)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      this.reportError(from, err);
      return;
    }

    // Dispatch — each handler is itself fully contained.
    void this.applySignal(from, kind, parsed);
  }

  /** Accept/ignore inbound remote video. */
  setRx(on: boolean): void {
    if (this.destroyed) return;
    if (this.rx === on) {
      this.refreshCachedStats();
      return;
    }
    this.rx = on;
    if (!on) {
      // Detach every surfaced stream.
      for (const rec of this.peers.values()) {
        if (rec.surfaced) {
          rec.surfaced = false;
          this.safeSurface(rec.id, null);
        }
      }
    } else {
      // Re-surface up to the cap.
      this.resurfaceWithinCap();
    }
    this.refreshCachedStats();
  }

  /** Start/stop sending local 480p video. Reject-safe. */
  async setTx(on: boolean): Promise<void> {
    if (this.destroyed) return;
    if (this.tx === on) return;
    try {
      if (on) {
        await this.startTx();
      } else {
        await this.stopTx();
      }
    } catch (err) {
      // Keep state consistent: on failure, fall back to TX-off.
      this.reportError(null, err);
      try {
        await this.stopTx();
      } catch (err2) {
        this.reportError(null, err2);
      }
    } finally {
      this.refreshCachedStats();
    }
  }

  /** Select capture devices; re-acquires local video if TX is currently on. */
  async setDevices(
    audioDeviceId: string | undefined,
    videoDeviceId: string | undefined,
  ): Promise<void> {
    if (this.destroyed) return;
    this.audioDeviceId = audioDeviceId;
    this.videoDeviceId = videoDeviceId;
    if (!this.tx) return;
    // Re-acquire with the new device and hot-swap into all senders.
    try {
      const newStream = await this.acquireLocalStream();
      const oldStream = this.localStream;
      this.localStream = newStream;
      const track = newStream.getVideoTracks()[0] ?? null;
      await this.replaceOutgoingTrack(track);
      // Stop the old stream's tracks now that senders point at the new one.
      this.stopStreamTracks(oldStream);
    } catch (err) {
      this.reportError(null, err);
    } finally {
      this.refreshCachedStats();
    }
  }

  isTx(): boolean {
    return this.tx;
  }

  isRx(): boolean {
    return this.rx;
  }

  /** Synchronous snapshot for the debug overlay. */
  getStats(): MeshStats {
    return this.cachedStats;
  }

  /** Tear down everything; stop local tracks. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    for (const id of Array.from(this.peers.keys())) {
      this.removePeer(id);
    }
    this.peers.clear();
    this.roster.clear();
    this.stopStreamTracks(this.localStream);
    this.localStream = null;
    this.tx = false;
    this.refreshCachedStats();
  }

  // -------------------------------------------------------------------------
  // Roles / peer lifecycle
  // -------------------------------------------------------------------------

  /**
   * Deterministic role rule: `selfId < peerId` => this side is the OFFERER
   * (the impolite peer who initiates). The other side is polite.
   */
  private isOfferer(peerId: string): boolean {
    return this.selfId < peerId;
  }

  /** Create (or fetch) the PeerRecord + RTCPeerConnection for a peer. */
  private ensurePeer(peerId: string): PeerRecord | null {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    if (this.destroyed) return null;

    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: this.iceServers });
    } catch (err) {
      this.reportError(peerId, err);
      return null;
    }

    const offerer = this.isOfferer(peerId);
    const rec: PeerRecord = {
      id: peerId,
      pc,
      polite: !offerer, // we're polite iff we are NOT the offerer
      makingOffer: false,
      ignoreOffer: false,
      videoTransceiver: null,
      remoteStream: null,
      surfaced: false,
      lastBytes: 0,
      lastStatsTs: 0,
      kbps: 0,
    };
    this.peers.set(peerId, rec);
    this.wirePc(rec);

    // Add the single video transceiver. Direction follows current TX state.
    try {
      const direction: RTCRtpTransceiverDirection = this.tx ? "sendrecv" : "recvonly";
      rec.videoTransceiver = pc.addTransceiver("video", { direction });
      // If TX is on and we have a local track, attach it to the new sender.
      if (this.tx) {
        const track = this.localStream?.getVideoTracks()[0] ?? null;
        if (track && rec.videoTransceiver?.sender) {
          void this.safeReplaceTrack(rec, track);
        }
      }
    } catch (err) {
      this.reportError(peerId, err);
    }

    return rec;
  }

  /** Wire all PC event handlers (each contained). */
  private wirePc(rec: PeerRecord): void {
    const { pc } = rec;

    pc.onnegotiationneeded = () => {
      // Only the offerer initiates; the polite side waits for an offer.
      if (!this.isOfferer(rec.id)) return;
      void this.doNegotiate(rec);
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.outboundSignal(rec.id, "candidate", ev.candidate.toJSON());
      }
    };

    pc.ontrack = (ev) => {
      try {
        const stream = ev.streams && ev.streams[0] ? ev.streams[0] : null;
        rec.remoteStream = stream;
        this.maybeSurface(rec);
      } catch (err) {
        this.reportError(rec.id, err);
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed") {
        // Degrade only this peer's video; keep the record unless fully gone.
        if (rec.surfaced) {
          rec.surfaced = false;
          this.safeSurface(rec.id, null);
        }
      } else if (st === "connected") {
        // (Re)attempt to surface now that media should be flowing.
        this.maybeSurface(rec);
      }
      this.refreshCachedStats();
    };

    // ICE failure recovery: try a restart from the offerer side.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed" && this.isOfferer(rec.id)) {
        try {
          pc.restartIce();
        } catch (err) {
          this.reportError(rec.id, err);
        }
      }
    };
  }

  /** Remove a peer entirely: detach video, close PC, drop record. */
  private removePeer(peerId: string): void {
    const rec = this.peers.get(peerId);
    if (!rec) return;
    this.peers.delete(peerId);
    if (rec.surfaced) {
      rec.surfaced = false;
    }
    // Always notify detach on removal.
    this.safeSurface(peerId, null);
    this.closePc(rec);
    // A removed peer may free local capture if no PC needs it anymore.
    this.maybeReleaseLocalStream();
  }

  private closePc(rec: PeerRecord): void {
    try {
      rec.pc.onnegotiationneeded = null;
      rec.pc.onicecandidate = null;
      rec.pc.ontrack = null;
      rec.pc.onconnectionstatechange = null;
      rec.pc.oniceconnectionstatechange = null;
      rec.pc.close();
    } catch (err) {
      this.reportError(rec.id, err);
    }
  }

  // -------------------------------------------------------------------------
  // Perfect negotiation
  // -------------------------------------------------------------------------

  private async doNegotiate(rec: PeerRecord): Promise<void> {
    const { pc } = rec;
    try {
      rec.makingOffer = true;
      // Modern browsers: setLocalDescription() with no arg creates the offer.
      await pc.setLocalDescription();
      if (pc.localDescription) {
        this.outboundSignal(rec.id, "offer", pc.localDescription);
      }
    } catch (err) {
      this.reportError(rec.id, err);
    } finally {
      rec.makingOffer = false;
    }
  }

  private async applySignal(from: string, kind: string, payload: unknown): Promise<void> {
    const rec = this.ensurePeer(from);
    if (!rec) return;

    switch (kind) {
      case "offer":
      case "answer":
        await this.handleDescription(rec, payload);
        break;
      case "candidate":
        await this.handleCandidate(rec, payload);
        break;
      default:
        // Unknown kind: ignore silently (forward-compat).
        break;
    }
  }

  private async handleDescription(rec: PeerRecord, payload: unknown): Promise<void> {
    const { pc } = rec;
    const desc = payload as RTCSessionDescriptionInit | null;
    if (!desc || typeof desc.type !== "string") return;

    const offerCollision =
      desc.type === "offer" && (rec.makingOffer || pc.signalingState !== "stable");

    // Impolite peer ignores a colliding offer; polite peer rolls back.
    rec.ignoreOffer = !rec.polite && offerCollision;
    if (rec.ignoreOffer) return;

    try {
      // setRemoteDescription with rollback semantics is handled internally by
      // the browser when polite + collision (it rolls back our local offer).
      await pc.setRemoteDescription(desc);
    } catch (err) {
      this.reportError(rec.id, err);
      return;
    }

    if (desc.type === "offer") {
      // Generate and send an answer.
      try {
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.outboundSignal(rec.id, "answer", pc.localDescription);
        }
      } catch (err) {
        this.reportError(rec.id, err);
      }
    }
  }

  private async handleCandidate(rec: PeerRecord, payload: unknown): Promise<void> {
    const cand = payload as RTCIceCandidateInit | null;
    // An empty candidate ({}) is a valid end-of-candidates signal in some stacks.
    try {
      await rec.pc.addIceCandidate(cand ?? undefined);
    } catch (err) {
      // If we deliberately ignored an offer, late candidates may fail — swallow
      // those quietly; otherwise surface.
      if (!rec.ignoreOffer) {
        this.reportError(rec.id, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Surfacing remote streams (RX + cap)
  // -------------------------------------------------------------------------

  /** Try to surface a peer's remote stream, respecting RX state and the cap. */
  private maybeSurface(rec: PeerRecord): void {
    if (!this.rx) {
      if (rec.surfaced) {
        rec.surfaced = false;
        this.safeSurface(rec.id, null);
      }
      this.refreshCachedStats();
      return;
    }
    if (!rec.remoteStream) {
      if (rec.surfaced) {
        rec.surfaced = false;
        this.safeSurface(rec.id, null);
      }
      this.refreshCachedStats();
      return;
    }
    if (rec.surfaced) {
      // Already surfaced — re-emit the (possibly new) stream object.
      this.safeSurface(rec.id, rec.remoteStream);
      this.refreshCachedStats();
      return;
    }
    // Not yet surfaced — only if under the cap.
    if (this.surfacedCount() < this.maxPeers) {
      rec.surfaced = true;
      this.safeSurface(rec.id, rec.remoteStream);
    }
    this.refreshCachedStats();
  }

  /** When RX comes back on, surface as many available streams as the cap allows. */
  private resurfaceWithinCap(): void {
    for (const rec of this.peers.values()) {
      if (!rec.surfaced && rec.remoteStream && this.surfacedCount() < this.maxPeers) {
        rec.surfaced = true;
        this.safeSurface(rec.id, rec.remoteStream);
      }
    }
  }

  private surfacedCount(): number {
    let n = 0;
    for (const rec of this.peers.values()) if (rec.surfaced) n++;
    return n;
  }

  /** Call onPeerStream, contained. */
  private safeSurface(peerId: string, stream: MediaStream | null): void {
    try {
      this.onPeerStream(peerId, stream);
    } catch (err) {
      this.reportError(peerId, err);
    }
  }

  // -------------------------------------------------------------------------
  // TX (local video) management
  // -------------------------------------------------------------------------

  private async startTx(): Promise<void> {
    // Acquire local capture (480p, video only).
    const stream = await this.acquireLocalStream();
    this.localStream = stream;
    this.tx = true;
    const track = stream.getVideoTracks()[0] ?? null;

    // Flip every transceiver to sendrecv and attach the track.
    for (const rec of this.peers.values()) {
      try {
        if (rec.videoTransceiver) {
          rec.videoTransceiver.direction = "sendrecv";
        }
        if (track) await this.safeReplaceTrack(rec, track);
      } catch (err) {
        this.reportError(rec.id, err);
      }
    }
  }

  private async stopTx(): Promise<void> {
    this.tx = false;
    // Replace outgoing track with null and set transceivers back to recvonly.
    for (const rec of this.peers.values()) {
      try {
        await this.safeReplaceTrack(rec, null);
        if (rec.videoTransceiver) {
          rec.videoTransceiver.direction = "recvonly";
        }
      } catch (err) {
        this.reportError(rec.id, err);
      }
    }
    // Stop and release local capture.
    this.stopStreamTracks(this.localStream);
    this.localStream = null;
  }

  /** getUserMedia for 480p video only (audio muted/none for v1). Throws on failure. */
  private async acquireLocalStream(): Promise<MediaStream> {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function") {
      throw new Error("getUserMedia unavailable");
    }
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 854 },
      height: { ideal: 480 },
      frameRate: { max: 30 },
    };
    if (this.videoDeviceId) {
      videoConstraints.deviceId = { exact: this.videoDeviceId };
    }
    return await md.getUserMedia({ video: videoConstraints, audio: false });
  }

  /** Replace the outgoing video track on every PC's video sender. */
  private async replaceOutgoingTrack(track: MediaStreamTrack | null): Promise<void> {
    for (const rec of this.peers.values()) {
      await this.safeReplaceTrack(rec, track);
    }
  }

  /** replaceTrack on a peer's video sender, contained. */
  private async safeReplaceTrack(rec: PeerRecord, track: MediaStreamTrack | null): Promise<void> {
    const sender = rec.videoTransceiver?.sender;
    if (!sender) return;
    try {
      await sender.replaceTrack(track);
    } catch (err) {
      this.reportError(rec.id, err);
    }
  }

  private stopStreamTracks(stream: MediaStream | null): void {
    if (!stream) return;
    try {
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {
          // ignore individual track stop failures
        }
      }
    } catch {
      // ignore
    }
  }

  /** Release the shared local stream if TX is off and nothing references it. */
  private maybeReleaseLocalStream(): void {
    if (!this.tx && this.localStream) {
      this.stopStreamTracks(this.localStream);
      this.localStream = null;
    }
  }

  // -------------------------------------------------------------------------
  // Signaling out
  // -------------------------------------------------------------------------

  private outboundSignal(to: string, kind: string, payload: unknown): void {
    try {
      this.sendSignal(to, kind, JSON.stringify(payload));
    } catch (err) {
      this.reportError(to, err);
    }
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  private ensureStatsTimer(): void {
    if (this.destroyed) return;
    if (this.statsTimer !== null) return;
    if (this.peers.size === 0) return;
    this.statsTimer = setInterval(() => {
      void this.gatherStats();
    }, 1000);
  }

  private async gatherStats(): Promise<void> {
    if (this.destroyed) return;
    if (this.peers.size === 0) {
      // No peers left — stop the timer to avoid idle work.
      if (this.statsTimer !== null) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
      }
      this.refreshCachedStats();
      return;
    }

    const now = Date.now();
    for (const rec of this.peers.values()) {
      try {
        const report = await rec.pc.getStats();
        let bytes = 0;
        report.forEach((stat) => {
          // Inbound video RTP bytes.
          const anyStat = stat as { type?: string; kind?: string; mediaType?: string; bytesReceived?: number };
          if (
            anyStat.type === "inbound-rtp" &&
            (anyStat.kind === "video" || anyStat.mediaType === "video") &&
            typeof anyStat.bytesReceived === "number"
          ) {
            bytes += anyStat.bytesReceived;
          }
        });
        if (rec.lastStatsTs > 0) {
          const dtSec = (now - rec.lastStatsTs) / 1000;
          const dBytes = bytes - rec.lastBytes;
          if (dtSec > 0 && dBytes >= 0) {
            rec.kbps = (dBytes * 8) / 1000 / dtSec;
          }
        }
        rec.lastBytes = bytes;
        rec.lastStatsTs = now;
      } catch (err) {
        this.reportError(rec.id, err);
      }
    }

    this.refreshCachedStats();
    if (this.onStats) {
      try {
        this.onStats(this.cachedStats);
      } catch (err) {
        this.reportError(null, err);
      }
    }
  }

  /** Recompute the cached MeshStats snapshot (cheap, synchronous). */
  private refreshCachedStats(): void {
    const peers: PeerStat[] = [];
    let rxStreams = 0;
    for (const rec of this.peers.values()) {
      const haveRemoteVideo = rec.surfaced && rec.remoteStream !== null;
      if (haveRemoteVideo) rxStreams++;
      peers.push({
        id: rec.id,
        state: rec.pc.connectionState,
        haveRemoteVideo,
        kbps: Math.round(rec.kbps),
      });
    }
    this.cachedStats = { peers, rxStreams, tx: this.tx, rx: this.rx };
  }

  // -------------------------------------------------------------------------
  // Error containment
  // -------------------------------------------------------------------------

  private reportError(peerId: string | null, err: unknown): void {
    try {
      this.onError?.(peerId, err);
    } catch {
      // Never let an error handler throw back into us.
    }
  }
}
