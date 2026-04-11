// Package sfu implements a Selective Forwarding Unit for Quipu voice rooms.
// Design principles:
//   - One PeerConnection per participant per room
//   - Server receives audio from each client, forwards to all others
//   - No transcoding — raw RTP forwarding only
//   - Renegotiation is guarded by per-peer mutex to prevent state machine conflicts
package sfu

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"go.uber.org/zap"
)

// SignalFunc sends a JSON message to a specific peer over the WS channel.
type SignalFunc func(fp string, msg map[string]any) error

// Peer represents one SFU participant.
type Peer struct {
	fp          string
	pc          *webrtc.PeerConnection
	ws          SignalFunc
	mu          sync.Mutex // serialises renegotiation for this peer
	pendingICE  []webrtc.ICECandidateInit
	remoteSet   bool
	regenTimer  *time.Timer // debounce renegotiation
}

// Room holds all peers and local tracks for a single voice channel.
type Room struct {
	mu     sync.Mutex
	name   string
	peers  map[string]*Peer
	tracks map[string]*webrtc.TrackLocalStaticRTP // trackID → local track
	log    *zap.Logger
}

// NewRoom creates an empty SFU room and starts the keyframe ticker.
func NewRoom(name string, log *zap.Logger) *Room {
	r := &Room{
		name:   name,
		peers:  make(map[string]*Peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
		log:    log,
	}
	go r.keyframeTicker()
	return r
}

func (r *Room) keyframeTicker() {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for range t.C {
		r.mu.Lock()
		for _, p := range r.peers {
			for _, recv := range p.pc.GetReceivers() {
				if recv.Track() == nil {
					continue
				}
				_ = p.pc.WriteRTCP([]rtcp.Packet{
					&rtcp.PictureLossIndication{MediaSSRC: uint32(recv.Track().SSRC())},
				})
			}
		}
		r.mu.Unlock()
	}
}

// ── Join / Leave ──────────────────────────────────────────────────────────────

// Join creates a PeerConnection for fp, adds existing tracks, creates the
// initial offer and returns it. Existing peers are renegotiated asynchronously.
func (r *Room) Join(fp string, ws SignalFunc) (*webrtc.SessionDescription, error) {
	r.log.Info("SFU join", zap.String("room", r.name), zap.String("fp", fp))

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{
				"stun:stun.l.google.com:19302",
				"stun:stun1.l.google.com:19302",
			}},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("NewPeerConnection: %w", err)
	}

	peer := &Peer{fp: fp, pc: pc, ws: ws}

	// sendrecv: receive audio from client, send others' audio back
	if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendrecv,
	}); err != nil {
		pc.Close()
		return nil, fmt.Errorf("AddTransceiverFromKind: %w", err)
	}

	// Trickle ICE → client
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		ci := c.ToJSON()
		_ = ws(fp, map[string]any{
			"type":          "sfu-ice",
			"candidate":     ci.Candidate,
			"sdpMid":        ci.SDPMid,
			"sdpMLineIndex": ci.SDPMLineIndex,
		})
	})

	// Clean up on connection failure
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		r.log.Info("SFU peer state",
			zap.String("fp", fp), zap.String("state", state.String()))
		switch state {
		case webrtc.PeerConnectionStateFailed,
			webrtc.PeerConnectionStateClosed:
			r.Leave(fp)
		}
	})

	// Incoming track from client → register and forward to all other peers
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		r.log.Info("SFU track received",
			zap.String("fp", fp), zap.String("kind", t.Kind().String()))
		local := r.registerTrack(fp, t)
		if local == nil {
			return
		}
		defer r.unregisterTrack(local.ID())
		r.forwardRTP(t, local)
	})

	r.mu.Lock()
	// Add all existing tracks from other peers to this new peer's PC
	for trackID, track := range r.tracks {
		ownerFp := ownerFromTrackID(trackID)
		if ownerFp == fp {
			continue
		}
		if _, err := pc.AddTrack(track); err != nil {
			r.log.Warn("AddTrack to new peer failed",
				zap.String("fp", fp), zap.Error(err))
		}
	}
	r.peers[fp] = peer
	r.mu.Unlock()

	// Create initial offer for this peer
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		r.removePeer(fp)
		pc.Close()
		return nil, fmt.Errorf("CreateOffer: %w", err)
	}
	if err = pc.SetLocalDescription(offer); err != nil {
		r.removePeer(fp)
		pc.Close()
		return nil, fmt.Errorf("SetLocalDescription: %w", err)
	}

	// Renegotiate all existing peers asynchronously to add a send slot for fp's future track
	go func() {
		time.Sleep(100 * time.Millisecond)
		r.mu.Lock()
		peers := r.copyPeers()
		r.mu.Unlock()
		for existFp, existPeer := range peers {
			if existFp == fp {
				continue
			}
			existPeer.mu.Lock()
			r.mu.Lock()
			r.scheduleRenegotiate(existPeer)
			r.mu.Unlock()
			existPeer.mu.Unlock()
		}
	}()

	return &offer, nil
}

// Answer processes the SDP answer from the client.
func (r *Room) Answer(fp string, answer webrtc.SessionDescription) error {
	r.mu.Lock()
	peer, ok := r.peers[fp]
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("peer %s not found", fp)
	}

	peer.mu.Lock()
	defer peer.mu.Unlock()

	if err := peer.pc.SetRemoteDescription(answer); err != nil {
		return err
	}
	peer.remoteSet = true

	// Flush any ICE candidates that arrived before the answer
	for _, c := range peer.pendingICE {
		if err := peer.pc.AddICECandidate(c); err != nil {
			r.log.Warn("pending ICE flush failed", zap.Error(err))
		}
	}
	peer.pendingICE = nil
	return nil
}

// AddICECandidate queues a candidate if the remote description isn't set yet.
func (r *Room) AddICECandidate(fp string, candidate webrtc.ICECandidateInit) error {
	r.mu.Lock()
	peer, ok := r.peers[fp]
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("peer %s not found", fp)
	}

	peer.mu.Lock()
	defer peer.mu.Unlock()

	if !peer.remoteSet {
		peer.pendingICE = append(peer.pendingICE, candidate)
		return nil
	}
	return peer.pc.AddICECandidate(candidate)
}

// Leave removes and closes a peer's connection.
func (r *Room) Leave(fp string) {
	peer := r.removePeer(fp)
	if peer == nil {
		return
	}
	r.log.Info("SFU leave", zap.String("room", r.name), zap.String("fp", fp))
	peer.pc.Close()
	// Renegotiate remaining peers to remove this peer's tracks
	go func() {
		time.Sleep(100 * time.Millisecond)
		r.mu.Lock()
		peers := r.copyPeers()
		r.mu.Unlock()
		for _, p := range peers {
			p.mu.Lock()
			r.mu.Lock()
			_ = r.renegotiate(p)
			r.mu.Unlock()
			p.mu.Unlock()
		}
	}()
}

func (r *Room) PeerCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.peers)
}

// ── Track management ──────────────────────────────────────────────────────────

// ownerFromTrackID extracts the fingerprint prefix from a track ID like "fp:trackid"
func ownerFromTrackID(id string) string {
	for i, c := range id {
		if c == ':' {
			return id[:i]
		}
	}
	return ""
}

func (r *Room) registerTrack(sourceFp string, remote *webrtc.TrackRemote) *webrtc.TrackLocalStaticRTP {
	trackID := sourceFp + ":" + remote.ID()
	local, err := webrtc.NewTrackLocalStaticRTP(
		remote.Codec().RTPCodecCapability,
		trackID,
		remote.StreamID(),
	)
	if err != nil {
		r.log.Error("NewTrackLocalStaticRTP failed", zap.Error(err))
		return nil
	}

	r.mu.Lock()
	r.tracks[trackID] = local
	// Immediately offer new track to all existing peers except the source
	peers := r.copyPeers()
	r.mu.Unlock()

	for fp, p := range peers {
		if fp == sourceFp {
			continue
		}
		p.mu.Lock()
		r.mu.Lock()
		if _, err := p.pc.AddTrack(local); err != nil {
			r.log.Warn("AddTrack after registerTrack failed",
				zap.String("fp", fp), zap.Error(err))
			r.mu.Unlock()
			p.mu.Unlock()
			continue
		}
		r.scheduleRenegotiate(p) // debounced — won't fire until 150ms after last call
		r.mu.Unlock()
		p.mu.Unlock()
	}

	return local
}

func (r *Room) unregisterTrack(trackID string) {
	r.mu.Lock()
	delete(r.tracks, trackID)
	r.mu.Unlock()
}

func (r *Room) forwardRTP(remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP) {
	buf := make([]byte, 1500)
	pkt := &rtp.Packet{}
	for {
		n, _, err := remote.Read(buf)
		if err != nil {
			return
		}
		if err = pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}
		pkt.Extension = false
		pkt.Extensions = nil
		if err = local.WriteRTP(pkt); err != nil {
			return
		}
	}
}

// ── Renegotiation ─────────────────────────────────────────────────────────────

// scheduleRenegotiate debounces renegotiation for a peer — multiple rapid track
// additions (e.g. audio + video arriving together) collapse into one offer.
// Caller must hold peer.mu and r.mu.
func (r *Room) scheduleRenegotiate(peer *Peer) {
	if peer.regenTimer != nil {
		peer.regenTimer.Stop()
	}
	p := peer
	peer.regenTimer = time.AfterFunc(150*time.Millisecond, func() {
		p.mu.Lock()
		r.mu.Lock()
		_ = r.renegotiate(p)
		r.mu.Unlock()
		p.mu.Unlock()
	})
}

// renegotiate sends a new offer to peer reflecting current track state.
// Caller must hold both peer.mu and r.mu.
func (r *Room) renegotiate(peer *Peer) error {
	// Only renegotiate if stable — otherwise wait for client to finish
	if peer.pc.SignalingState() != webrtc.SignalingStateStable {
		return nil
	}
	if peer.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
		return nil
	}

	// Add any missing tracks
	sending := map[string]bool{}
	for _, sender := range peer.pc.GetSenders() {
		if sender.Track() == nil {
			continue
		}
		sending[sender.Track().ID()] = true
		// Remove senders whose track is gone
		if _, exists := r.tracks[sender.Track().ID()]; !exists {
			if err := peer.pc.RemoveTrack(sender); err != nil {
				return err
			}
		}
	}
	for _, recv := range peer.pc.GetReceivers() {
		if recv.Track() != nil {
			sending[recv.Track().ID()] = true
		}
	}
	for trackID, track := range r.tracks {
		if ownerFromTrackID(trackID) == peer.fp {
			continue
		}
		if !sending[trackID] {
			if _, err := peer.pc.AddTrack(track); err != nil {
				return err
			}
		}
	}

	offer, err := peer.pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err = peer.pc.SetLocalDescription(offer); err != nil {
		return err
	}
	offerJSON, err := json.Marshal(offer)
	if err != nil {
		return err
	}
	return peer.ws(peer.fp, map[string]any{
		"type": "sfu-offer",
		"sdp":  string(offerJSON),
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func (r *Room) removePeer(fp string) *Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	peer, ok := r.peers[fp]
	if !ok {
		return nil
	}
	delete(r.peers, fp)
	return peer
}

func (r *Room) copyPeers() map[string]*Peer {
	out := make(map[string]*Peer, len(r.peers))
	for k, v := range r.peers {
		out[k] = v
	}
	return out
}
