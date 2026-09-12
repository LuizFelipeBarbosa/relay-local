// Package coordinator is an in-memory reference gateway for private testing.
package coordinator

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"relay/internal/config"
	"relay/internal/wire"
	"relay/protocol"
)

type host struct {
	id            string
	peer          *wire.Peer
	backends      []protocol.Backend
	jobs          map[string]*job
	lastHeartbeat atomic.Int64
}

type job struct {
	id       string
	host     *host
	backend  protocol.Backend
	model    protocol.Model
	events   chan protocol.Message
	failure  chan string
	queued   atomic.Int64
	dropping atomic.Bool
	started  bool // accessed only by this host's read loop
	seq      uint64
}

type Coordinator struct {
	config   config.Coordinator
	logger   *slog.Logger
	buyerKey string
	hostKeys map[string]string
	mu       sync.Mutex
	hosts    map[string]*host
	cursor   uint64
	closed   bool
}

func New(c config.Coordinator, logger *slog.Logger) (*Coordinator, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	buyer, err := config.Secret(c.BuyerTokenEnv)
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	s := &Coordinator{config: c, logger: logger, buyerKey: buyer, hostKeys: map[string]string{}, hosts: map[string]*host{}}
	seen := map[string]bool{buyer: true}
	for id, env := range c.Hosts {
		key, err := config.Secret(env)
		if err != nil {
			return nil, err
		}
		if seen[key] {
			return nil, errors.New("each host and buyer must have a distinct credential")
		}
		seen[key] = true
		s.hostKeys[id] = key
	}
	return s, nil
}

func (s *Coordinator) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+protocol.ConnectPath, s.connect)
	mux.HandleFunc("GET /v1/models", s.authorize(s.models))
	mux.HandleFunc("POST /v1/chat/completions", s.authorize(s.chat))
	return mux
}

func (s *Coordinator) Close() {
	s.mu.Lock()
	s.closed = true
	for _, h := range s.hosts {
		h.peer.Close()
	}
	s.mu.Unlock()
}

func keyMatches(r *http.Request, key string) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && subtle.ConstantTimeCompare([]byte(got), []byte(key)) == 1
}

func secure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	return err == nil && config.LoopbackName(host)
}

func (s *Coordinator) authorize(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !secure(r) {
			apiError(w, 403, "tls_required")
			return
		}
		if !keyMatches(r, s.buyerKey) {
			apiError(w, 401, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (s *Coordinator) connect(w http.ResponseWriter, r *http.Request) {
	if !secure(r) {
		apiError(w, 403, "tls_required")
		return
	}
	id := ""
	for hostID, key := range s.hostKeys {
		if keyMatches(r, key) {
			id = hostID
		}
	}
	if id == "" {
		apiError(w, 401, "unauthorized")
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := wire.New(ctx, conn)
	defer p.Close()
	hctx, stop := wire.HandshakeContext(ctx)
	hello, err := p.Read(hctx)
	stop()
	if err != nil || hello.Type != "hello" || hello.HostID != id || protocol.ValidateCatalog(hello.Backends) != nil {
		return
	}
	h := &host{id: id, peer: p, backends: hello.Backends, jobs: map[string]*job{}}
	h.lastHeartbeat.Store(time.Now().UnixNano())
	s.mu.Lock()
	// Reject duplicate live identities; a diagnostics probe cannot evict a host.
	if s.closed || s.hosts[id] != nil {
		s.mu.Unlock()
		return
	}
	s.hosts[id] = h
	s.mu.Unlock()
	defer s.remove(h)
	if p.Send(ctx, protocol.Message{Type: "welcome", HostID: id}) != nil {
		return
	}
	s.logger.Info("host registered", "host_id", id)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if time.Since(time.Unix(0, h.lastHeartbeat.Load())) >= protocol.HeartbeatTimeout {
					p.Close()
					return
				}
			}
		}
	}()
	var heartbeatID uint64
	for {
		m, err := p.Read(ctx)
		if err != nil {
			return
		}
		switch m.Type {
		case "heartbeat":
			if m.HeartbeatID <= heartbeatID {
				return
			}
			heartbeatID = m.HeartbeatID
			h.lastHeartbeat.Store(time.Now().UnixNano())
			if p.Send(ctx, protocol.Message{Type: "heartbeat_ack", HeartbeatID: m.HeartbeatID}) != nil {
				return
			}
		case "catalog":
			if protocol.ValidateCatalog(m.Backends) != nil {
				return
			}
			s.mu.Lock()
			h.backends = m.Backends
			s.mu.Unlock()
		case "response_start", "response_chunk", "response_end", "error":
			if !s.deliver(h, m) {
				return
			}
		default:
			return
		}
	}
}

func (s *Coordinator) remove(h *host) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hosts[h.id] != h {
		return
	}
	delete(s.hosts, h.id)
	for _, j := range h.jobs {
		select {
		case j.failure <- "host_disconnected":
		default:
		}
	}
	s.logger.Info("host disconnected", "host_id", h.id)
}

func (s *Coordinator) deliver(h *host, m protocol.Message) bool {
	s.mu.Lock()
	j := h.jobs[m.AttemptID]
	s.mu.Unlock()
	if j == nil {
		return true
	} // late data for an abandoned attempt
	terminal := m.Type == "response_end" || m.Type == "error"
	if !j.dropping.Load() {
		switch m.Type {
		case "response_start":
			if j.started {
				return false
			}
			j.started = true
		case "response_chunk":
			if !j.started || m.Seq != j.seq+1 {
				return false
			}
			j.seq = m.Seq
		case "response_end":
			if !j.started {
				return false
			}
		}
	}
	if terminal {
		s.mu.Lock()
		delete(h.jobs, j.id)
		s.mu.Unlock()
	}
	if j.dropping.Load() {
		return true
	}
	queued := j.queued.Add(int64(len(m.Data)))
	if queued <= protocol.QueueBytes {
		select {
		case j.events <- m:
			return true
		default:
		}
	}
	j.queued.Add(-int64(len(m.Data)))
	select {
	case j.failure <- "slow_consumer":
	default:
	}
	s.abandon(j)
	return true
}

func (s *Coordinator) abandon(j *job) {
	if j.dropping.Swap(true) {
		return
	}
	s.mu.Lock()
	pending := j.host.jobs[j.id] == j
	s.mu.Unlock()
	if !pending {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), protocol.WriteTimeout)
		defer cancel()
		if j.host.peer.Send(ctx, protocol.Message{Type: "cancel", AttemptID: j.id}) != nil {
			j.host.peer.Close()
			return
		}
		// Do not release capacity until the agent acknowledges cleanup. An
		// unresponsive agent loses its entire session instead of being overbooked.
		timer := time.NewTimer(protocol.WriteTimeout)
		defer timer.Stop()
		select {
		case <-j.host.peer.Done():
			return
		case <-timer.C:
		}
		s.mu.Lock()
		pending := j.host.jobs[j.id] == j
		s.mu.Unlock()
		if pending {
			j.host.peer.Close()
		}
	}()
}

func (s *Coordinator) selectJob(modelID, excludedHost string, previous *job) *job {
	s.mu.Lock()
	defer s.mu.Unlock()
	var candidates []*job
	ids := make([]string, 0, len(s.hosts))
	for id := range s.hosts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		h := s.hosts[id]
		if id == excludedHost || time.Since(time.Unix(0, h.lastHeartbeat.Load())) >= protocol.HeartbeatTimeout {
			continue
		}
		for _, b := range h.backends {
			if !b.Ready {
				continue
			}
			active := 0
			for _, j := range h.jobs {
				if j.backend.ID == b.ID {
					active++
				}
			}
			if active >= b.Capacity {
				continue
			}
			for _, m := range b.Models {
				if m.ID != modelID {
					continue
				}
				if previous != nil && (b.Source != previous.backend.Source || b.Kind != previous.backend.Kind || (b.Source == "local" && m.Digest != previous.model.Digest)) {
					continue
				}
				candidates = append(candidates, &job{id: protocol.ID(), host: h, backend: b, model: m, events: make(chan protocol.Message, 10), failure: make(chan string, 1)})
			}
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	j := candidates[s.cursor%uint64(len(candidates))]
	s.cursor++
	j.host.jobs[j.id] = j
	return j
}

func (s *Coordinator) models(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	seen := map[string]bool{}
	for _, h := range s.hosts {
		for _, b := range h.backends {
			if b.Ready {
				for _, m := range b.Models {
					seen[m.ID] = true
				}
			}
		}
	}
	s.mu.Unlock()
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	data := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		data = append(data, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": "relay"})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
}

func apiError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"type": "relay_error", "code": code, "message": code}})
}
