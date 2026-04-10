package sfu

import (
	"sync"

	"go.uber.org/zap"
)

// Manager holds all active SFU rooms.
type Manager struct {
	mu     sync.RWMutex
	rooms  map[string]*Room // channel name → Room
	log    *zap.Logger
	signal SignalFunc
}

func NewManager(log *zap.Logger, signal SignalFunc) *Manager {
	return &Manager{
		rooms:  make(map[string]*Room),
		log:    log,
		signal: signal,
	}
}

// GetOrCreate returns the Room for a channel, creating it if needed.
func (m *Manager) GetOrCreate(channel string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rooms[channel]; ok {
		return r
	}
	r := NewRoom(channel, m.log, m.signal)
	m.rooms[channel] = r
	m.log.Info("SFU room created", zap.String("channel", channel))
	return r
}

// Get returns a room or nil if it doesn't exist.
func (m *Manager) Get(channel string) *Room {
	m.mu.RLock(); defer m.mu.RUnlock()
	return m.rooms[channel]
}

// GC removes empty rooms.
func (m *Manager) GC(channel string) {
	m.mu.Lock(); defer m.mu.Unlock()
	if r, ok := m.rooms[channel]; ok && r.PeerCount() == 0 {
		delete(m.rooms, channel)
		m.log.Info("SFU room removed", zap.String("channel", channel))
	}
}

// LeaveAll removes a peer from all rooms (called on disconnect).
func (m *Manager) LeaveAll(fp string) {
	m.mu.RLock()
	rooms := make([]*Room, 0, len(m.rooms))
	names := make([]string, 0, len(m.rooms))
	for name, r := range m.rooms {
		rooms = append(rooms, r)
		names = append(names, name)
	}
	m.mu.RUnlock()

	for i, r := range rooms {
		r.Leave(fp)
		m.GC(names[i])
	}
}

// Stats returns basic room info for the health endpoint.
func (m *Manager) Stats() map[string]int {
	m.mu.RLock(); defer m.mu.RUnlock()
	out := make(map[string]int, len(m.rooms))
	for name, r := range m.rooms {
		out[name] = r.PeerCount()
	}
	return out
}
