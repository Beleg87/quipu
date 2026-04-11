package sfu

import (
	"sync"

	"go.uber.org/zap"
)

// Manager holds all active SFU rooms.
type Manager struct {
	mu    sync.Mutex
	rooms map[string]*Room
	log   *zap.Logger
}

func NewManager(log *zap.Logger) *Manager {
	return &Manager{rooms: make(map[string]*Room), log: log}
}

func (m *Manager) GetOrCreate(channel string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rooms[channel]; ok {
		return r
	}
	r := NewRoom(channel, m.log)
	m.rooms[channel] = r
	m.log.Info("SFU room created", zap.String("channel", channel))
	return r
}

func (m *Manager) Get(channel string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[channel]
}

func (m *Manager) GC(channel string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rooms[channel]; ok && r.PeerCount() == 0 {
		delete(m.rooms, channel)
		m.log.Info("SFU room removed", zap.String("channel", channel))
	}
}

func (m *Manager) LeaveAll(fp string) {
	m.mu.Lock()
	rooms := make(map[string]*Room, len(m.rooms))
	for name, r := range m.rooms {
		rooms[name] = r
	}
	m.mu.Unlock()
	for name, r := range rooms {
		r.Leave(fp)
		m.GC(name)
	}
}

func (m *Manager) Stats() map[string]int {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]int, len(m.rooms))
	for name, r := range m.rooms {
		out[name] = r.PeerCount()
	}
	return out
}
