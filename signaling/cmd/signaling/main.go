package main

import (
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/quipu-app/quipu/signaling/internal/sfu"
	"github.com/quipu-app/quipu/signaling/internal/updater"
	"go.uber.org/zap"
)

// Version is set at build time via -ldflags. Falls back to "dev".
var Version = "dev"

// ── Config ────────────────────────────────────────────────────────────────────

type Config struct {
	Addr     string
	TLSCert  string
	TLSKey   string
	DataFile string
	AdminFp  string
}

func configFromFlags() Config {
	addr  := flag.String("addr",      ":8080",           "listen address")
	cert  := flag.String("tls-cert",  "",                "TLS certificate path (optional)")
	key   := flag.String("tls-key",   "",                "TLS key path (optional)")
	data  := flag.String("data-file", "quipu-data.json", "persistent data file (bans + mods)")
	admin := flag.String("admin",     "",                "permanent admin fingerprint")
	flag.Parse()
	return Config{Addr: *addr, TLSCert: *cert, TLSKey: *key, DataFile: *data, AdminFp: *admin}
}

// ── Message types ─────────────────────────────────────────────────────────────

type MessageType string

const (
	// Existing signaling
	MsgOffer     MessageType = "offer"
	MsgAnswer    MessageType = "answer"
	MsgCandidate MessageType = "candidate"
	MsgJoin      MessageType = "join"
	MsgLeave     MessageType = "leave"
	MsgChat      MessageType = "chat"
	MsgHistory   MessageType = "history"
	MsgRole      MessageType = "role"
	MsgPromote   MessageType = "promote"
	MsgKick      MessageType = "kick"
	MsgBan       MessageType = "ban"
	MsgUnban     MessageType = "unban"
	MsgMove      MessageType = "move"
	MsgCommand   MessageType = "command"
	MsgActivity  MessageType = "activity"
	MsgPing      MessageType = "ping"
	MsgPong      MessageType = "pong"
	MsgError     MessageType = "error"

	// SFU signaling (server ↔ client)
	MsgSFUJoin        MessageType = "sfu-join"         // client → server: join SFU room
	MsgSFUOffer       MessageType = "sfu-offer"        // server → client: SFU offer
	MsgSFUAnswer      MessageType = "sfu-answer"       // client → server: SFU answer
	MsgSFUICE         MessageType = "sfu-ice"          // bidirectional: ICE candidates
	MsgSFULeave       MessageType = "sfu-leave"        // client → server: leave SFU room
	MsgSFUScreenStart MessageType = "sfu-screen-start" // client → server → all: peer started sharing
	MsgSFUScreenStop  MessageType = "sfu-screen-stop"  // client → server → all: peer stopped sharing
)

type Message struct {
	Type    MessageType     `json:"type"`
	Room    string          `json:"room,omitempty"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type StoredMessage struct {
	From    string          `json:"from"`
	Payload json.RawMessage `json:"payload"`
	At      int64           `json:"at"`
}

// ── Persistent data store ─────────────────────────────────────────────────────

type persistedData struct {
	Bans map[string]string          `json:"bans"`
	Mods map[string]map[string]bool `json:"mods"`
}

type DataStore struct {
	mu       sync.RWMutex
	data     persistedData
	filePath string
	log      *zap.Logger
}

func loadDataStore(path string, log *zap.Logger) *DataStore {
	ds := &DataStore{
		data:     persistedData{Bans: make(map[string]string), Mods: make(map[string]map[string]bool)},
		filePath: path,
		log:      log,
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ds
	}
	if err := json.Unmarshal(raw, &ds.data); err != nil {
		log.Warn("failed to parse data file, starting fresh", zap.Error(err))
		return ds
	}
	if ds.data.Bans == nil {
		ds.data.Bans = make(map[string]string)
	}
	if ds.data.Mods == nil {
		ds.data.Mods = make(map[string]map[string]bool)
	}
	log.Info("loaded persistent data",
		zap.Int("bans", len(ds.data.Bans)),
		zap.Int("mod_rooms", len(ds.data.Mods)))
	return ds
}

func (ds *DataStore) save() {
	ds.mu.RLock()
	raw, _ := json.MarshalIndent(ds.data, "", "  ")
	ds.mu.RUnlock()
	if err := os.WriteFile(ds.filePath, raw, 0644); err != nil {
		ds.log.Warn("failed to save data", zap.Error(err))
	}
}

func (ds *DataStore) isBanned(fp string) (bool, string) {
	ds.mu.RLock(); defer ds.mu.RUnlock()
	r, ok := ds.data.Bans[fp]
	return ok, r
}

func (ds *DataStore) ban(fp, reason string) {
	ds.mu.Lock(); ds.data.Bans[fp] = reason; ds.mu.Unlock()
	ds.save()
}

func (ds *DataStore) unban(fp string) bool {
	ds.mu.Lock()
	_, existed := ds.data.Bans[fp]
	delete(ds.data.Bans, fp)
	ds.mu.Unlock()
	if existed {
		ds.save()
	}
	return existed
}

func (ds *DataStore) listBans() map[string]string {
	ds.mu.RLock(); defer ds.mu.RUnlock()
	out := make(map[string]string, len(ds.data.Bans))
	for k, v := range ds.data.Bans {
		out[k] = v
	}
	return out
}

func (ds *DataStore) getMods(room string) map[string]bool {
	ds.mu.RLock(); defer ds.mu.RUnlock()
	m := ds.data.Mods[room]
	out := make(map[string]bool, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (ds *DataStore) setMod(room, fp string, isMod bool) {
	ds.mu.Lock()
	if ds.data.Mods[room] == nil {
		ds.data.Mods[room] = make(map[string]bool)
	}
	if isMod {
		ds.data.Mods[room][fp] = true
	} else {
		delete(ds.data.Mods[room], fp)
	}
	ds.mu.Unlock()
	ds.save()
}

// ── WS peer & room ────────────────────────────────────────────────────────────

type Peer struct {
	fingerprint  string
	conn         *threadSafeWriter
	send         chan []byte
	room         string
	joinedAt     time.Time
	lastActivity time.Time
}

type Room struct {
	mu      sync.RWMutex
	peers   map[string]*Peer
	history []StoredMessage
	admin   string
	mods    map[string]bool
}

func newRoom() *Room {
	return &Room{peers: make(map[string]*Peer), mods: make(map[string]bool)}
}

func (r *Room) isPrivileged(fp string) bool {
	r.mu.RLock(); defer r.mu.RUnlock()
	return fp == r.admin || r.mods[fp]
}

func (r *Room) role(fp string) string {
	r.mu.RLock(); defer r.mu.RUnlock()
	if fp == r.admin {
		return "admin"
	}
	if r.mods[fp] {
		return "mod"
	}
	return "member"
}

func (r *Room) add(p *Peer) {
	r.mu.Lock(); defer r.mu.Unlock()
	if len(r.peers) == 0 {
		r.admin = p.fingerprint
	}
	r.peers[p.fingerprint] = p
}

func (r *Room) remove(fp string) {
	r.mu.Lock(); defer r.mu.Unlock()
	delete(r.peers, fp)
}

func (r *Room) broadcast(data []byte, except string) {
	r.mu.RLock(); defer r.mu.RUnlock()
	for fp, p := range r.peers {
		if fp != except {
			select {
			case p.send <- data:
			default:
			}
		}
	}
}

func (r *Room) unicast(data []byte, to string) bool {
	r.mu.RLock(); defer r.mu.RUnlock()
	p, ok := r.peers[to]
	if !ok {
		return false
	}
	select {
	case p.send <- data:
	default:
	}
	return true
}

func (r *Room) size() int {
	r.mu.RLock(); defer r.mu.RUnlock()
	return len(r.peers)
}

func (r *Room) appendHistory(msg StoredMessage) {
	r.mu.Lock(); defer r.mu.Unlock()
	r.history = append(r.history, msg)
	if len(r.history) > 200 {
		r.history = r.history[len(r.history)-200:]
	}
}

func (r *Room) getHistory() []StoredMessage {
	r.mu.RLock(); defer r.mu.RUnlock()
	out := make([]StoredMessage, len(r.history))
	copy(out, r.history)
	return out
}

// ── Hub ───────────────────────────────────────────────────────────────────────

type Hub struct {
	mu      sync.RWMutex
	rooms   map[string]*Room
	sfuMgr  *sfu.Manager
	store   *DataStore
	adminFp string
	log     *zap.Logger
}

func newHub(store *DataStore, sfuMgr *sfu.Manager, adminFp string, log *zap.Logger) *Hub {
	return &Hub{
		rooms:   make(map[string]*Room),
		sfuMgr:  sfuMgr,
		store:   store,
		adminFp: adminFp,
		log:     log,
	}
}

func (h *Hub) room(name string) *Room {
	h.mu.Lock(); defer h.mu.Unlock()
	r, ok := h.rooms[name]
	if !ok {
		r = newRoom()
		h.rooms[name] = r
	}
	return r
}

func (h *Hub) gc(name string) {
	h.mu.Lock(); defer h.mu.Unlock()
	if r, ok := h.rooms[name]; ok && r.size() == 0 {
		delete(h.rooms, name)
	}
}

func (h *Hub) sendRole(room *Room, fp string) {
	role := room.role(fp)
	admin := room.admin
	mods := []string{}
	room.mu.RLock()
	for m := range room.mods {
		mods = append(mods, m)
	}
	room.mu.RUnlock()
	payload, _ := json.Marshal(map[string]any{
		"role":  role,
		"admin": admin,
		"mods":  mods,
		"bans":  h.store.listBans(),
	})
	msg, _ := json.Marshal(Message{Type: MsgRole, Payload: payload})
	room.unicast(msg, fp)
}

func (h *Hub) broadcastRoles(room *Room) {
	admin := room.admin
	mods := []string{}
	room.mu.RLock()
	for m := range room.mods {
		mods = append(mods, m)
	}
	peers := make([]string, 0, len(room.peers))
	for fp := range room.peers {
		peers = append(peers, fp)
	}
	room.mu.RUnlock()
	for _, fp := range peers {
		role := room.role(fp)
		payload, _ := json.Marshal(map[string]any{
			"role":  role,
			"admin": admin,
			"mods":  mods,
			"bans":  h.store.listBans(),
		})
		msg, _ := json.Marshal(Message{Type: MsgRole, Payload: payload})
		room.unicast(msg, fp)
	}
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	CheckOrigin:    func(r *http.Request) bool { return true },
	ReadBufferSize: 4096, WriteBufferSize: 4096,
}

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 50 * time.Second
	maxMessageSize = 64 * 1024
	afkTimeout     = 10 * time.Minute
	afkCheckPeriod = 1 * time.Minute
)

func (h *Hub) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Warn("upgrade failed", zap.Error(err))
		return
	}
	safe := &threadSafeWriter{conn, sync.Mutex{}}
	peer := &Peer{conn: safe, send: make(chan []byte, 64), joinedAt: time.Now(), lastActivity: time.Now()}
	go peer.writePump(h.log)
	peer.readPump(h)
}

func (p *Peer) readPump(h *Hub) {
	defer func() {
		p.conn.Close()
		if p.room == "" {
			return
		}
		room := h.room(p.room)
		room.remove(p.fingerprint)
		h.gc(p.room)
		// Leave SFU if in one
		h.sfuMgr.LeaveAll(p.fingerprint)
		leave, _ := json.Marshal(Message{Type: MsgLeave, Room: p.room, From: p.fingerprint})
		room.broadcast(leave, p.fingerprint)
		h.log.Info("peer left", zap.String("fp", p.fingerprint), zap.String("room", p.room))
	}()

	p.conn.SetReadLimit(maxMessageSize)
	_ = p.conn.SetReadDeadline(time.Now().Add(pongWait))
	p.conn.SetPongHandler(func(string) error {
		return p.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := p.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				h.log.Warn("read error", zap.Error(err))
			}
			return
		}
		p.lastActivity = time.Now()

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			h.log.Warn("bad json", zap.Error(err))
			continue
		}

		switch msg.Type {

		case MsgPing:
			pong, _ := json.Marshal(Message{Type: MsgPong})
			p.send <- pong

		case MsgActivity:
			// Voice activity heartbeat — lastActivity already updated above

		// ── SFU messages ──────────────────────────────────────────────────────

		case MsgSFUJoin:
			// Payload: {"channel": "Main"}
			var payload struct {
				Channel string `json:"channel"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.Channel == "" {
				p.send <- errMsg("sfu-join: channel required")
				continue
			}
			sfuRoom := h.sfuMgr.GetOrCreate(payload.Channel)

			// Signal function: sends SFU messages back over this WS connection
			signalFn := func(fp string, m map[string]any) error {
				data, err := json.Marshal(m)
				if err != nil {
					return err
				}
				p.send <- data
				return nil
			}

			offer, err := sfuRoom.Join(p.fingerprint, signalFn)
			if err != nil {
				h.log.Error("SFU join failed", zap.Error(err))
				p.send <- errMsg("sfu join failed: " + err.Error())
				continue
			}
			offerJSON, _ := json.Marshal(offer)
			resp, _ := json.Marshal(map[string]any{
				"type": "sfu-offer",
				"sdp":  string(offerJSON),
			})
			p.send <- resp
			h.log.Info("SFU joined", zap.String("fp", p.fingerprint), zap.String("channel", payload.Channel))

		case MsgSFUAnswer:
			// Payload: {"channel": "Main", "sdp": "..."}
			var payload struct {
				Channel string `json:"channel"`
				SDP     string `json:"sdp"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			sfuRoom := h.sfuMgr.Get(payload.Channel)
			if sfuRoom == nil {
				continue
			}
			var answer webrtc.SessionDescription
			if err := json.Unmarshal([]byte(payload.SDP), &answer); err != nil {
				continue
			}
			if err := sfuRoom.Answer(p.fingerprint, answer); err != nil {
				h.log.Debug("SFU answer skipped", zap.Error(err))
			}

		case MsgSFUICE:
			// Payload: {"channel": "Main", "candidate": "...", "sdpMid": "...", "sdpMLineIndex": 0}
			var payload struct {
				Channel       string  `json:"channel"`
				Candidate     string  `json:"candidate"`
				SDPMid        *string `json:"sdpMid"`
				SDPMLineIndex *uint16 `json:"sdpMLineIndex"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			sfuRoom := h.sfuMgr.Get(payload.Channel)
			if sfuRoom == nil {
				continue
			}
			candidate := webrtc.ICECandidateInit{
				Candidate:     payload.Candidate,
				SDPMid:        payload.SDPMid,
				SDPMLineIndex: payload.SDPMLineIndex,
			}
			if err := sfuRoom.AddICECandidate(p.fingerprint, candidate); err != nil {
				// "peer not found" is expected when candidates arrive after peer left — not an error
				h.log.Debug("SFU ICE candidate skipped", zap.Error(err))
			}

		case MsgSFULeave:
			var payload struct {
				Channel string `json:"channel"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			if sfuRoom := h.sfuMgr.Get(payload.Channel); sfuRoom != nil {
				sfuRoom.Leave(p.fingerprint)
				h.sfuMgr.GC(payload.Channel)
			}

		case MsgSFUScreenStart, MsgSFUScreenStop:
			// Broadcast to all peers in the room so they know who is sharing
			if p.room == "" {
				continue
			}
			msg.From = p.fingerprint
			fwd, _ := json.Marshal(msg)
			h.room(p.room).broadcast(fwd, p.fingerprint)

		// ── Existing signaling (unchanged) ────────────────────────────────────

		case MsgJoin:
			if msg.From == "" || msg.Room == "" {
				p.send <- errMsg("from and room required")
				continue
			}
			if banned, reason := h.store.isBanned(msg.From); banned {
				payload, _ := json.Marshal(map[string]string{"reason": reason})
				bannedMsg, _ := json.Marshal(Message{Type: MsgError, Payload: payload, From: "server"})
				p.send <- bannedMsg
				p.conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(4003, "banned: "+reason))
				return
			}
			p.fingerprint = msg.From
			p.room = msg.Room
			room := h.room(msg.Room)
			room.mu.RLock()
			for fp := range room.peers {
				if fp != p.fingerprint {
					existing, _ := json.Marshal(Message{Type: MsgJoin, Room: p.room, From: fp})
					p.send <- existing
				}
			}
			room.mu.RUnlock()
			if history := room.getHistory(); len(history) > 0 {
				histPayload, _ := json.Marshal(history)
				histMsg, _ := json.Marshal(Message{Type: MsgHistory, Room: p.room, Payload: histPayload})
				p.send <- histMsg
			}
			room.add(p)
			room.mu.Lock()
			if h.adminFp != "" {
				room.admin = h.adminFp
			} else if room.admin == "" {
				room.admin = p.fingerprint
			}
			for fp, isMod := range h.store.getMods(msg.Room) {
				if isMod {
					room.mods[fp] = true
				} else {
					delete(room.mods, fp)
				}
			}
			room.mu.Unlock()
			room.broadcast(raw, p.fingerprint)
			h.broadcastRoles(room)
			go h.afkChecker(p.room)
			h.log.Info("peer joined", zap.String("fp", p.fingerprint), zap.String("room", p.room), zap.Int("peers", room.size()))

		case MsgOffer, MsgAnswer, MsgCandidate:
			if p.room == "" {
				continue
			}
			msg.From = p.fingerprint
			fwd, _ := json.Marshal(msg)
			room := h.room(p.room)
			if msg.To != "" {
				room.unicast(fwd, msg.To)
			} else {
				room.broadcast(fwd, p.fingerprint)
			}

		case MsgChat:
			if p.room == "" {
				continue
			}
			msg.From = p.fingerprint
			fwd, _ := json.Marshal(msg)
			h.room(p.room).appendHistory(StoredMessage{
				From:    p.fingerprint,
				Payload: msg.Payload,
				At:      time.Now().UnixMilli(),
			})
			h.room(p.room).broadcast(fwd, p.fingerprint)

		case MsgPromote:
			if p.room == "" {
				continue
			}
			room := h.room(p.room)
			if room.admin != p.fingerprint {
				p.send <- errMsg("only admin can promote/demote")
				continue
			}
			var payload struct {
				Target string `json:"target"`
				Role   string `json:"role"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			isMod := payload.Role == "mod"
			room.mu.Lock()
			if isMod {
				room.mods[payload.Target] = true
			} else {
				delete(room.mods, payload.Target)
			}
			room.mu.Unlock()
			h.store.setMod(p.room, payload.Target, isMod)
			h.broadcastRoles(room)

		case MsgKick:
			if p.room == "" {
				continue
			}
			room := h.room(p.room)
			if !room.isPrivileged(p.fingerprint) {
				p.send <- errMsg("insufficient permissions")
				continue
			}
			var payload struct {
				Target string `json:"target"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			if payload.Target == room.admin {
				p.send <- errMsg("cannot kick admin")
				continue
			}
			cmd, _ := json.Marshal(map[string]string{"action": "kicked", "by": p.fingerprint})
			cmdMsg, _ := json.Marshal(Message{Type: MsgCommand, Payload: cmd})
			room.unicast(cmdMsg, payload.Target)
			go func(target string) {
				time.Sleep(500 * time.Millisecond)
				room.mu.RLock()
				peer, ok := room.peers[target]
				room.mu.RUnlock()
				if ok {
					peer.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4000, "kicked"))
					peer.conn.Close()
				}
			}(payload.Target)

		case MsgBan:
			if p.room == "" {
				continue
			}
			room := h.room(p.room)
			if !room.isPrivileged(p.fingerprint) {
				p.send <- errMsg("insufficient permissions")
				continue
			}
			var payload struct {
				Target string `json:"target"`
				Reason string `json:"reason"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			if payload.Target == room.admin {
				p.send <- errMsg("cannot ban admin")
				continue
			}
			reason := payload.Reason
			if reason == "" {
				reason = "banned"
			}
			h.store.ban(payload.Target, reason)
			cmd, _ := json.Marshal(map[string]string{"action": "banned", "reason": reason, "by": p.fingerprint})
			cmdMsg, _ := json.Marshal(Message{Type: MsgCommand, Payload: cmd})
			room.unicast(cmdMsg, payload.Target)
			go func(target string) {
				time.Sleep(500 * time.Millisecond)
				room.mu.RLock()
				peer, ok := room.peers[target]
				room.mu.RUnlock()
				if ok {
					peer.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4003, "banned: "+reason))
					peer.conn.Close()
				}
			}(payload.Target)
			h.broadcastRoles(room)

		case MsgUnban:
			if p.room == "" {
				continue
			}
			room := h.room(p.room)
			if !room.isPrivileged(p.fingerprint) {
				p.send <- errMsg("insufficient permissions")
				continue
			}
			var payload struct {
				Target string `json:"target"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			h.store.unban(payload.Target)
			h.broadcastRoles(room)

		case MsgMove:
			if p.room == "" {
				continue
			}
			room := h.room(p.room)
			if !room.isPrivileged(p.fingerprint) {
				p.send <- errMsg("insufficient permissions")
				continue
			}
			var payload struct {
				Target  string `json:"target"`
				Channel string `json:"channel"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			cmd, _ := json.Marshal(map[string]string{"action": "move", "channel": payload.Channel})
			cmdMsg, _ := json.Marshal(Message{Type: MsgCommand, Payload: cmd})
			room.unicast(cmdMsg, payload.Target)
		}
	}
}

func (h *Hub) afkChecker(roomName string) {
	ticker := time.NewTicker(afkCheckPeriod)
	defer ticker.Stop()
	for range ticker.C {
		room := h.room(roomName)
		if room.size() == 0 {
			return
		}
		now := time.Now()
		room.mu.RLock()
		var afkPeers []string
		for fp, p := range room.peers {
			if now.Sub(p.lastActivity) > afkTimeout {
				afkPeers = append(afkPeers, fp)
			}
		}
		room.mu.RUnlock()
		for _, fp := range afkPeers {
			cmd, _ := json.Marshal(map[string]string{"action": "move", "channel": "AFK"})
			cmdMsg, _ := json.Marshal(Message{Type: MsgCommand, Payload: cmd})
			room.unicast(cmdMsg, fp)
		}
	}
}

func errMsg(text string) []byte {
	payload, _ := json.Marshal(text)
	msg, _ := json.Marshal(Message{Type: MsgError, Payload: payload})
	return msg
}

// ── Thread-safe writer ────────────────────────────────────────────────────────

type threadSafeWriter struct {
	*websocket.Conn
	sync.Mutex
}

func (t *threadSafeWriter) WriteJSON(v any) error {
	t.Lock(); defer t.Unlock()
	return t.Conn.WriteJSON(v)
}

func (p *Peer) writePump(log *zap.Logger) {
	ticker := time.NewTicker(pingPeriod)
	defer func() { ticker.Stop(); p.conn.Close() }()
	for {
		select {
		case data, ok := <-p.send:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = p.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := p.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Warn("write error", zap.Error(err))
				return
			}
		case <-ticker.C:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// ── Health ────────────────────────────────────────────────────────────────────

func (h *Hub) healthHandler(w http.ResponseWriter, _ *http.Request) {
	h.mu.RLock()
	roomCount := len(h.rooms)
	h.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":    "ok",
		"rooms":     roomCount,
		"sfu_rooms": h.sfuMgr.Stats(),
		"bans":      len(h.store.listBans()),
		"time":      time.Now().UTC(),
	})
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	cfg := configFromFlags()

	var log *zap.Logger
	var err error
	if os.Getenv("QUIPU_ENV") == "production" {
		log, err = zap.NewProduction()
	} else {
		log, err = zap.NewDevelopment()
	}
	if err != nil {
		panic(err)
	}
	defer log.Sync()

	log.Info("quipu signaling server", zap.String("version", Version))

	// ── Clean up any .old binary left from a previous Windows update ──────────
	updater.CleanupOldBinary(log)

	// ── Self-update check ─────────────────────────────────────────────────────
	// Skip update check if running as "dev" build or if QUIPU_NO_UPDATE is set.
	if Version != "dev" && os.Getenv("QUIPU_NO_UPDATE") == "" {
		if shouldRestart := updater.CheckAndUpdate(Version, log); shouldRestart {
			log.Info("restarting with updated binary...")
			log.Sync()
			// Re-exec self — the new binary is already in place
			exe, err := os.Executable()
			if err != nil {
				log.Error("could not determine executable path for restart", zap.Error(err))
			} else {
				cmd := exec.Command(exe, os.Args[1:]...)
				cmd.Stdout = os.Stdout
				cmd.Stderr = os.Stderr
				cmd.Stdin  = os.Stdin
				if err := cmd.Start(); err != nil {
					log.Error("restart failed", zap.Error(err))
				} else {
					os.Exit(0) // old process exits cleanly
				}
			}
		}
	}

	// ── Server ────────────────────────────────────────────────────────────────
	store := loadDataStore(cfg.DataFile, log)

	sfuMgr := sfu.NewManager(log)
	hub    := newHub(store, sfuMgr, cfg.AdminFp, log)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", hub.serveWS)
	mux.HandleFunc("/health", hub.healthHandler)

	log.Info("quipu server starting",
		zap.String("addr", cfg.Addr),
		zap.String("data", cfg.DataFile),
		zap.String("version", Version))

	if cfg.TLSCert != "" && cfg.TLSKey != "" {
		err = http.ListenAndServeTLS(cfg.Addr, cfg.TLSCert, cfg.TLSKey, mux)
	} else {
		err = http.ListenAndServe(cfg.Addr, mux)
	}
	if err != nil {
		log.Fatal("server error", zap.Error(err))
	}
}
