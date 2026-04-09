package main

import (
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

type Config struct {
	Addr    string
	TLSCert string
	TLSKey  string
}

func configFromFlags() Config {
	addr := flag.String("addr", ":8080", "listen address")
	cert := flag.String("tls-cert", "", "TLS certificate path (optional)")
	key  := flag.String("tls-key",  "", "TLS key path (optional)")
	flag.Parse()
	return Config{Addr: *addr, TLSCert: *cert, TLSKey: *key}
}

type MessageType string

const (
	MsgOffer     MessageType = "offer"
	MsgAnswer    MessageType = "answer"
	MsgCandidate MessageType = "candidate"
	MsgJoin      MessageType = "join"
	MsgLeave     MessageType = "leave"
	MsgChat      MessageType = "chat"      // ← Phase 1: E2EE text relay
	MsgPing      MessageType = "ping"
	MsgPong      MessageType = "pong"
	MsgError     MessageType = "error"
)

type Message struct {
	Type    MessageType     `json:"type"`
	Room    string          `json:"room,omitempty"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type Peer struct {
	fingerprint string
	conn        *websocket.Conn
	send        chan []byte
	room        string
	joinedAt    time.Time
}

type Room struct {
	mu    sync.RWMutex
	peers map[string]*Peer
}

func newRoom() *Room { return &Room{peers: make(map[string]*Peer)} }

func (r *Room) add(p *Peer) {
	r.mu.Lock(); defer r.mu.Unlock()
	r.peers[p.fingerprint] = p
}

func (r *Room) remove(fingerprint string) {
	r.mu.Lock(); defer r.mu.Unlock()
	delete(r.peers, fingerprint)
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
	if !ok { return false }
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

type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*Room
	log   *zap.Logger
}

func newHub(log *zap.Logger) *Hub { return &Hub{rooms: make(map[string]*Room), log: log} }

func (h *Hub) room(name string) *Room {
	h.mu.Lock(); defer h.mu.Unlock()
	r, ok := h.rooms[name]
	if !ok { r = newRoom(); h.rooms[name] = r }
	return r
}

func (h *Hub) gc(name string) {
	h.mu.Lock(); defer h.mu.Unlock()
	if r, ok := h.rooms[name]; ok && r.size() == 0 { delete(h.rooms, name) }
}

var upgrader = websocket.Upgrader{
	CheckOrigin:    func(r *http.Request) bool { return true },
	ReadBufferSize: 4096, WriteBufferSize: 4096,
}

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 50 * time.Second
	maxMessageSize = 64 * 1024
)

func (h *Hub) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil { h.log.Warn("upgrade failed", zap.Error(err)); return }
	peer := &Peer{conn: conn, send: make(chan []byte, 64), joinedAt: time.Now()}
	go peer.writePump(h.log)
	peer.readPump(h)
}

func (p *Peer) readPump(h *Hub) {
	defer func() {
		p.conn.Close()
		if p.room != "" {
			room := h.room(p.room)
			room.remove(p.fingerprint)
			h.gc(p.room)
			leave, _ := json.Marshal(Message{Type: MsgLeave, Room: p.room, From: p.fingerprint})
			room.broadcast(leave, p.fingerprint)
			h.log.Info("peer left", zap.String("fp", p.fingerprint), zap.String("room", p.room))
		}
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

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			h.log.Warn("bad json", zap.Error(err)); continue
		}

		switch msg.Type {
		case MsgPing:
			pong, _ := json.Marshal(Message{Type: MsgPong})
			p.send <- pong

		case MsgJoin:
			if msg.From == "" || msg.Room == "" {
				errMsg, _ := json.Marshal(Message{Type: MsgError, Payload: json.RawMessage(`"from and room required"`)})
				p.send <- errMsg; continue
			}
			p.fingerprint = msg.From
			p.room = msg.Room
			room := h.room(msg.Room)
			room.add(p)
			room.broadcast(raw, p.fingerprint)
			h.log.Info("peer joined", zap.String("fp", p.fingerprint), zap.String("room", p.room),
				zap.Int("peers", room.size()))

		case MsgOffer, MsgAnswer, MsgCandidate:
			if p.room == "" { continue }
			msg.From = p.fingerprint
			fwd, _ := json.Marshal(msg)
			room := h.room(p.room)
			if msg.To != "" { room.unicast(fwd, msg.To) } else { room.broadcast(fwd, p.fingerprint) }

		case MsgChat:
			// Relay chat messages to all peers in the room.
			// The payload is an opaque encrypted blob — the server never reads it.
			if p.room == "" { continue }
			msg.From = p.fingerprint
			fwd, _ := json.Marshal(msg)
			h.room(p.room).broadcast(fwd, p.fingerprint)
		}
	}
}

func (p *Peer) writePump(log *zap.Logger) {
	ticker := time.NewTicker(pingPeriod)
	defer func() { ticker.Stop(); p.conn.Close() }()
	for {
		select {
		case data, ok := <-p.send:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok { _ = p.conn.WriteMessage(websocket.CloseMessage, []byte{}); return }
			if err := p.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Warn("write error", zap.Error(err)); return
			}
		case <-ticker.C:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil { return }
		}
	}
}

func (h *Hub) healthHandler(w http.ResponseWriter, _ *http.Request) {
	h.mu.RLock(); roomCount := len(h.rooms); h.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "ok", "rooms": roomCount, "time": time.Now().UTC()})
}

func main() {
	cfg := configFromFlags()
	var log *zap.Logger
	var err error
	if os.Getenv("QUIPU_ENV") == "production" {
		log, err = zap.NewProduction()
	} else {
		log, err = zap.NewDevelopment()
	}
	if err != nil { panic(err) }
	defer log.Sync()

	hub := newHub(log)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws",     hub.serveWS)
	mux.HandleFunc("/health", hub.healthHandler)

	log.Info("quipu signaling starting", zap.String("addr", cfg.Addr))
	if cfg.TLSCert != "" && cfg.TLSKey != "" {
		err = http.ListenAndServeTLS(cfg.Addr, cfg.TLSCert, cfg.TLSKey, mux)
	} else {
		err = http.ListenAndServe(cfg.Addr, mux)
	}
	if err != nil { log.Fatal("server error", zap.Error(err)) }
}
