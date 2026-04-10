// Package sfu implements a Selective Forwarding Unit for Quipu voice rooms.
// Each Room manages a set of PeerConnections and forwards audio RTP packets
// between them without decoding. No transcoding — pure forwarding.
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

// ── Types ─────────────────────────────────────────────────────────────────────

// SignalFunc sends a JSON message to a specific peer over the WS channel.
type SignalFunc func(fp string, msg map[string]any) error

// Peer represents one SFU participant.
type Peer struct {
	fp   string
	pc   *webrtc.PeerConnection
	ws   SignalFunc
	mu   sync.Mutex
	done chan struct{}
}

// Room holds all peers and local tracks for a single voice channel.
type Room struct {
	mu      sync.RWMutex
	name    string
	peers   map[string]*Peer            // fp → Peer
	tracks  map[string]*webrtc.TrackLocalStaticRTP // trackID → local track
	log     *zap.Logger
	signal  SignalFunc
}

// ── Room ──────────────────────────────────────────────────────────────────────

func NewRoom(name string, log *zap.Logger, signal SignalFunc) *Room {
	r := &Room{
		name:   name,
		peers:  make(map[string]*Peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
		log:    log,
		signal: signal,
	}
	// Keyframe requests every 3 seconds keep video/screen share healthy
	go r.keyframeTicker()
	return r
}

func (r *Room) keyframeTicker() {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for range t.C {
		r.mu.RLock()
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
		r.mu.RUnlock()
	}
}

// ── Peer join / leave ─────────────────────────────────────────────────────────

// Join creates a PeerConnection for a new participant and starts signaling.
// The returned offer should be sent to the client over WS.
func (r *Room) Join(fp string, ws SignalFunc) (*webrtc.SessionDescription, error) {
	r.log.Info("SFU join", zap.String("room", r.name), zap.String("fp", fp))

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("NewPeerConnection: %w", err)
	}

	peer := &Peer{fp: fp, pc: pc, ws: ws, done: make(chan struct{})}

	// Accept one audio track from the client (sendrecv — they send, we also send back)
	if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendrecv,
	}); err != nil {
		pc.Close()
		return nil, fmt.Errorf("AddTransceiverFromKind audio: %w", err)
	}

	// ICE candidates → send to client
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		ci := c.ToJSON()
		if err := ws(fp, map[string]any{
			"type":      "sfu-ice",
			"candidate": ci.Candidate,
			"sdpMid":    ci.SDPMid,
			"sdpMLineIndex": ci.SDPMLineIndex,
		}); err != nil {
			r.log.Warn("ICE candidate send failed", zap.Error(err))
		}
	})

	// Connection state changes
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		r.log.Info("SFU peer state", zap.String("fp", fp), zap.String("state", state.String()))
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			r.Leave(fp)
		}
	})

	// Incoming tracks from this peer → fan out to all others
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		r.log.Info("SFU track received",
			zap.String("fp", fp),
			zap.String("kind", t.Kind().String()),
			zap.String("id", t.ID()))
		trackLocal := r.addTrack(fp, t)
		defer r.removeTrack(trackLocal)
		r.forwardRTP(t, trackLocal)
	})

	// Register peer before signaling so tracks get added
	r.mu.Lock()
	r.peers[fp] = peer
	r.mu.Unlock()

	// Signal: give this peer all existing tracks, and give all others this peer's slot
	r.signalAll()

	// Create offer for this peer
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		r.Leave(fp)
		return nil, fmt.Errorf("CreateOffer: %w", err)
	}
	if err = pc.SetLocalDescription(offer); err != nil {
		r.Leave(fp)
		return nil, fmt.Errorf("SetLocalDescription: %w", err)
	}

	return &offer, nil
}

// Answer processes the client's SDP answer.
func (r *Room) Answer(fp string, answer webrtc.SessionDescription) error {
	r.mu.RLock()
	peer, ok := r.peers[fp]
	r.mu.RUnlock()
	if !ok {
		return fmt.Errorf("peer %s not found", fp)
	}
	return peer.pc.SetRemoteDescription(answer)
}

// AddICECandidate processes a trickled ICE candidate from the client.
func (r *Room) AddICECandidate(fp string, candidate webrtc.ICECandidateInit) error {
	r.mu.RLock()
	peer, ok := r.peers[fp]
	r.mu.RUnlock()
	if !ok {
		return fmt.Errorf("peer %s not found", fp)
	}
	return peer.pc.AddICECandidate(candidate)
}

// Leave closes and removes a peer from the room.
func (r *Room) Leave(fp string) {
	r.mu.Lock()
	peer, ok := r.peers[fp]
	if ok {
		delete(r.peers, fp)
	}
	r.mu.Unlock()
	if !ok {
		return
	}
	r.log.Info("SFU leave", zap.String("room", r.name), zap.String("fp", fp))
	peer.pc.Close()
	r.signalAll()
}

func (r *Room) PeerCount() int {
	r.mu.RLock(); defer r.mu.RUnlock()
	return len(r.peers)
}

// ── Track management ──────────────────────────────────────────────────────────

func (r *Room) addTrack(sourceFp string, remote *webrtc.TrackRemote) *webrtc.TrackLocalStaticRTP {
	r.mu.Lock()
	defer func() {
		r.mu.Unlock()
		r.signalAll()
	}()

	// Use fingerprint-prefixed ID so peers don't get their own audio back
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
	r.tracks[trackID] = local
	return local
}

func (r *Room) removeTrack(local *webrtc.TrackLocalStaticRTP) {
	if local == nil {
		return
	}
	r.mu.Lock()
	delete(r.tracks, local.ID())
	r.mu.Unlock()
	r.signalAll()
}

func (r *Room) forwardRTP(remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP) {
	if local == nil {
		return
	}
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
		// Strip extensions that can cause issues across different codecs
		pkt.Extension = false
		pkt.Extensions = nil
		if err = local.WriteRTP(pkt); err != nil {
			return
		}
	}
}

// ── Renegotiation ─────────────────────────────────────────────────────────────

// signalAll updates every peer's PeerConnection so it has all tracks except its own.
func (r *Room) signalAll() {
	r.mu.Lock()
	defer r.mu.Unlock()

	for attempt := 0; attempt < 25; attempt++ {
		if !r.attemptSync() {
			return
		}
	}
	// Too many retries — schedule a deferred sync
	go func() {
		time.Sleep(3 * time.Second)
		r.signalAll()
	}()
}

func (r *Room) attemptSync() (needRetry bool) {
	for fp, peer := range r.peers {
		if peer.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			delete(r.peers, fp)
			return true
		}

		// Build set of tracks we're already sending to this peer
		sending := map[string]bool{}
		for _, sender := range peer.pc.GetSenders() {
			if sender.Track() == nil {
				continue
			}
			sending[sender.Track().ID()] = true
			// Remove senders for tracks that no longer exist
			if _, exists := r.tracks[sender.Track().ID()]; !exists {
				if err := peer.pc.RemoveTrack(sender); err != nil {
					return true
				}
			}
		}
		// Don't loop back tracks from this peer's own receivers
		for _, recv := range peer.pc.GetReceivers() {
			if recv.Track() != nil {
				sending[recv.Track().ID()] = true
			}
		}

		// Add tracks this peer should receive (all tracks except its own)
		for trackID, track := range r.tracks {
			// Skip this peer's own tracks (prefixed with their fp)
			if len(trackID) > len(fp) && trackID[:len(fp)] == fp {
				continue
			}
			if !sending[trackID] {
				if _, err := peer.pc.AddTrack(track); err != nil {
					return true
				}
			}
		}

		// Create new offer for this peer
		offer, err := peer.pc.CreateOffer(nil)
		if err != nil {
			return true
		}
		if err = peer.pc.SetLocalDescription(offer); err != nil {
			return true
		}
		offerJSON, err := json.Marshal(offer)
		if err != nil {
			r.log.Error("marshal offer failed", zap.Error(err))
			return true
		}
		if err = peer.ws(fp, map[string]any{
			"type": "sfu-offer",
			"sdp":  string(offerJSON),
		}); err != nil {
			r.log.Warn("send offer failed", zap.String("fp", fp), zap.Error(err))
			return true
		}
	}
	return false
}
