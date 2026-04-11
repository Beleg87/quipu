// Package sfu implements a Selective Forwarding Unit for Quipu voice rooms.
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
	fp  string
	pc  *webrtc.PeerConnection
	ws  SignalFunc
}

// Room holds all peers and local tracks for a single voice channel.
type Room struct {
	mu     sync.Mutex
	name   string
	peers  map[string]*Peer
	tracks map[string]*webrtc.TrackLocalStaticRTP
	log    *zap.Logger
	signal SignalFunc
}

func NewRoom(name string, log *zap.Logger, signal SignalFunc) *Room {
	r := &Room{
		name:   name,
		peers:  make(map[string]*Peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
		log:    log,
		signal: signal,
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

// Join creates a PeerConnection for a new participant.
// It registers the peer, adds existing tracks to it, creates an offer and
// returns it. It does NOT call signalAll for this peer — that would cause the
// double-SetLocalDescription error. Existing peers are renegotiated separately.
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

	peer := &Peer{fp: fp, pc: pc, ws: ws}

	// sendrecv: we want to receive from the client and send others' audio back
	if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendrecv,
	}); err != nil {
		pc.Close()
		return nil, fmt.Errorf("AddTransceiverFromKind: %w", err)
	}

	// Trickle ICE to client
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
		r.log.Info("SFU peer state", zap.String("fp", fp), zap.String("state", state.String()))
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			r.Leave(fp)
		}
	})

	// Incoming audio track from client → fan out to all other peers
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		r.log.Info("SFU track received", zap.String("fp", fp), zap.String("kind", t.Kind().String()))
		local := r.addTrack(fp, t)
		if local == nil {
			return
		}
		defer r.removeTrack(local)
		r.forwardRTP(t, local)
	})

	r.mu.Lock()

	// Add all existing tracks (from other peers) to this new peer's PC
	for trackID, track := range r.tracks {
		// skip own tracks (shouldn't exist yet, but defensive)
		if len(trackID) > len(fp) && trackID[:len(fp)] == fp {
			continue
		}
		if _, err := pc.AddTrack(track); err != nil {
			r.log.Warn("AddTrack to new peer failed", zap.Error(err))
		}
	}

	r.peers[fp] = peer

	r.mu.Unlock()

	// Create the initial offer for this peer only
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

	// Renegotiate all OTHER existing peers so they get a slot for this new peer's tracks
	// (tracks themselves are added in addTrack when OnTrack fires)
	go r.renegotiateExisting(fp)

	return &offer, nil
}

// renegotiateExisting sends new offers to all peers except the one who just joined.
// Called in a goroutine after Join so it doesn't block or race with SetLocalDescription.
func (r *Room) renegotiateExisting(exceptFp string) {
	time.Sleep(50 * time.Millisecond) // tiny delay to let ICE gathering start
	r.mu.Lock()
	defer r.mu.Unlock()
	for fp, peer := range r.peers {
		if fp == exceptFp {
			continue
		}
		if peer.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			continue
		}
		if err := r.offerPeer(peer); err != nil {
			r.log.Warn("renegotiate existing peer failed", zap.String("fp", fp), zap.Error(err))
		}
	}
}

// offerPeer creates and sends a new offer to a single peer (must hold r.mu).
func (r *Room) offerPeer(peer *Peer) error {
	// Build set of tracks already being sent
	sending := map[string]bool{}
	for _, sender := range peer.pc.GetSenders() {
		if sender.Track() == nil {
			continue
		}
		sending[sender.Track().ID()] = true
		// Remove senders for tracks that no longer exist
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
	// Add missing tracks (skip own tracks)
	for trackID, track := range r.tracks {
		if len(trackID) > len(peer.fp) && trackID[:len(peer.fp)] == peer.fp {
			continue
		}
		if !sending[trackID] {
			if _, err := peer.pc.AddTrack(track); err != nil {
				return err
			}
		}
	}
	// Only renegotiate if signaling state is stable
	if peer.pc.SignalingState() != webrtc.SignalingStateStable {
		return nil // skip — client will handle renegotiation via rollback
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

func (r *Room) Answer(fp string, answer webrtc.SessionDescription) error {
	r.mu.Lock()
	peer, ok := r.peers[fp]
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("peer %s not found", fp)
	}
	return peer.pc.SetRemoteDescription(answer)
}

func (r *Room) AddICECandidate(fp string, candidate webrtc.ICECandidateInit) error {
	r.mu.Lock()
	peer, ok := r.peers[fp]
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("peer %s not found", fp)
	}
	return peer.pc.AddICECandidate(candidate)
}

func (r *Room) Leave(fp string) {
	peer := r.removePeer(fp)
	if peer == nil {
		return
	}
	r.log.Info("SFU leave", zap.String("room", r.name), zap.String("fp", fp))
	peer.pc.Close()
	// Renegotiate remaining peers to remove this peer's tracks
	go r.renegotiateExisting("")
}

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

func (r *Room) PeerCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.peers)
}

// ── Track management ──────────────────────────────────────────────────────────

func (r *Room) addTrack(sourceFp string, remote *webrtc.TrackRemote) *webrtc.TrackLocalStaticRTP {
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
	// Immediately add this track to all existing peers except the source
	for fp, peer := range r.peers {
		if fp == sourceFp {
			continue
		}
		if _, err := peer.pc.AddTrack(local); err != nil {
			r.log.Warn("AddTrack to existing peer failed", zap.String("fp", fp), zap.Error(err))
			continue
		}
		// Renegotiate this peer if stable
		if peer.pc.SignalingState() == webrtc.SignalingStateStable {
			p := peer
			go func() {
				r.mu.Lock()
				defer r.mu.Unlock()
				if err := r.offerPeer(p); err != nil {
					r.log.Warn("offer after addTrack failed", zap.Error(err))
				}
			}()
		}
	}
	r.mu.Unlock()

	return local
}

func (r *Room) removeTrack(local *webrtc.TrackLocalStaticRTP) {
	if local == nil {
		return
	}
	r.mu.Lock()
	delete(r.tracks, local.ID())
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
