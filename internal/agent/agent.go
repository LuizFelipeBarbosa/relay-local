package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"mime"
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"relay/internal/backend"
	"relay/internal/config"
	"relay/internal/wire"
	"relay/protocol"
)

type slot struct {
	runtime *backend.Runtime
	catalog protocol.Backend
	active  int
}

type Agent struct {
	config config.Agent
	logger *slog.Logger
	mu     sync.Mutex
	slots  []*slot
	event  func(AttemptEvent)
}

type AttemptEvent struct {
	RequestID string
	AttemptID string
	BackendID string
	Model     string
	Type      string
	Code      string
	Duration  time.Duration
	Usage     json.RawMessage
	Bytes     int64
	TextBytes int64
}

func New(c config.Agent, logger *slog.Logger) (*Agent, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	a := &Agent{config: c, logger: logger}
	for _, b := range c.Backends {
		a.slots = append(a.slots, &slot{runtime: backend.New(b)})
	}
	return a, nil
}

func (a *Agent) Close() {
	for _, s := range a.slots {
		s.runtime.Close()
	}
}

func (a *Agent) SetEventHandler(handler func(AttemptEvent)) {
	a.mu.Lock()
	a.event = handler
	a.mu.Unlock()
}

func (a *Agent) emit(event AttemptEvent) {
	a.mu.Lock()
	handler := a.event
	a.mu.Unlock()
	if handler != nil {
		handler(event)
	}
}

func (a *Agent) Discover(ctx context.Context) []protocol.Backend {
	var wg sync.WaitGroup
	for _, s := range a.slots {
		wg.Add(1)
		go func(s *slot) {
			defer wg.Done()
			catalog, err := s.runtime.Discover(ctx)
			if err != nil {
				a.logger.Warn("backend unavailable", "backend_id", s.runtime.Config.ID)
			}
			a.mu.Lock()
			s.catalog = catalog
			a.mu.Unlock()
		}(s)
	}
	wg.Wait()
	return a.Catalog()
}

// Inventory discovers every model exposed by each configured runtime. It is
// intentionally separate from Catalog, which contains only offered models.
func (a *Agent) Inventory(ctx context.Context) []protocol.Backend {
	var wg sync.WaitGroup
	result := make([]protocol.Backend, len(a.slots))
	for i, s := range a.slots {
		wg.Add(1)
		go func(i int, s *slot) {
			defer wg.Done()
			catalog, err := s.runtime.DiscoverAll(ctx)
			if err != nil {
				a.logger.Warn("backend inventory unavailable", "backend_id", s.runtime.Config.ID)
			}
			result[i] = catalog
		}(i, s)
	}
	wg.Wait()
	return result
}

func (a *Agent) Catalog() []protocol.Backend {
	a.mu.Lock()
	defer a.mu.Unlock()
	catalog := make([]protocol.Backend, 0, len(a.slots))
	for _, s := range a.slots {
		b := s.catalog
		b.Available = b.Capacity - s.active
		catalog = append(catalog, b)
	}
	return catalog
}

func (a *Agent) Run(ctx context.Context) error {
	if _, err := config.Secret(a.config.TokenEnv); err != nil {
		return err
	}
	backoff := time.Second
	for ctx.Err() == nil {
		a.Discover(ctx)
		started := time.Now()
		err := a.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, errUnauthorized) {
			return err
		}
		a.logger.Warn("coordinator disconnected; reconnecting")
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		delay := backoff/2 + time.Duration(rand.Int64N(int64(backoff/2)+1))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		backoff = min(backoff*2, 30*time.Second)
	}
	return nil
}

var errUnauthorized = errors.New("coordinator rejected host credential; check token and host mapping")

func (a *Agent) dial(ctx context.Context) (*websocket.Conn, error) {
	key, err := config.Secret(a.config.TokenEnv)
	if err != nil {
		return nil, err
	}
	hctx, cancel := wire.HandshakeContext(ctx)
	defer cancel()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	conn, resp, err := websocket.Dial(hctx, a.config.CoordinatorURL, &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Authorization": []string{"Bearer " + key}}})
	if err != nil {
		if resp != nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
			return nil, errUnauthorized
		}
		return nil, errors.New("coordinator connection failed")
	}
	return conn, nil
}

func (a *Agent) connect(ctx context.Context) (*wire.Peer, error) {
	conn, err := a.dial(ctx)
	if err != nil {
		return nil, err
	}
	hctx, cancel := wire.HandshakeContext(ctx)
	defer cancel()
	p := wire.New(ctx, conn)
	hello := protocol.Message{Type: "hello", HostID: a.config.HostID, AgentVersion: "0.1.0", OS: runtime.GOOS, Arch: runtime.GOARCH, Backends: a.Catalog()}
	if err = p.Send(hctx, hello); err == nil {
		var welcome protocol.Message
		welcome, err = p.Read(hctx)
		if err == nil && (welcome.Type != "welcome" || welcome.HostID != a.config.HostID) {
			err = errors.New("invalid welcome")
		}
	}
	if err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

// Probe authenticates the upgrade without registering or advertising capacity.
func (a *Agent) Probe(ctx context.Context) error {
	conn, err := a.dial(ctx)
	if conn != nil {
		_ = conn.CloseNow()
	}
	return err
}

func (a *Agent) session(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	p, err := a.connect(ctx)
	if err != nil {
		return err
	}
	defer p.Close()
	a.logger.Info("host connected", "host_id", a.config.HostID)
	var wg sync.WaitGroup
	var attemptsMu sync.Mutex
	active := map[string]context.CancelFunc{}
	seen := map[string]bool{}
	defer func() { cancel(); p.Close(); wg.Wait() }()
	var sent, acked atomic.Uint64
	var lastAck atomic.Int64
	lastAck.Store(time.Now().UnixNano())
	wg.Add(2)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(protocol.HeartbeatInterval)
		defer ticker.Stop()
		watchdog := time.NewTicker(time.Second)
		defer watchdog.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-p.Done():
				cancel()
				return
			case <-watchdog.C:
				if time.Since(time.Unix(0, lastAck.Load())) >= protocol.HeartbeatTimeout {
					cancel()
					p.Close()
					return
				}
			case <-ticker.C:
				if p.Send(ctx, protocol.Message{Type: "heartbeat", HeartbeatID: sent.Add(1)}) != nil {
					cancel()
					return
				}
			}
		}
	}()
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				catalog := a.Discover(ctx)
				if p.Send(ctx, protocol.Message{Type: "catalog", Backends: catalog}) != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		m, err := p.Read(ctx)
		if err != nil {
			return err
		}
		switch m.Type {
		case "heartbeat_ack":
			if m.HeartbeatID > acked.Load() && m.HeartbeatID <= sent.Load() {
				acked.Store(m.HeartbeatID)
				lastAck.Store(time.Now().UnixNano())
			}
		case "cancel":
			attemptsMu.Lock()
			stop := active[m.AttemptID]
			attemptsMu.Unlock()
			if stop != nil {
				stop()
			}
		case "request":
			// IDs live for the whole session, including rejected/completed attempts.
			// Rotate the connection instead of retaining an unbounded replay cache.
			if seen[m.AttemptID] || len(seen) >= 100000 {
				return errors.New("duplicate attempt or session limit")
			}
			seen[m.AttemptID] = true
			s, model, code := a.reserve(m)
			if code != "" {
				if p.Send(ctx, protocol.Message{Type: "error", AttemptID: m.AttemptID, Code: code, Retryable: code == "busy" || code == "backend_unavailable"}) != nil {
					return errors.New("connection lost")
				}
				continue
			}
			total := min(time.Duration(m.TimeoutMS)*time.Millisecond, time.Duration(a.config.TotalTimeoutSeconds)*time.Second)
			jobCtx, stop := context.WithTimeout(ctx, total)
			attemptsMu.Lock()
			active[m.AttemptID] = stop
			attemptsMu.Unlock()
			wg.Add(1)
			go func(m protocol.Message, s *slot, model string) {
				defer wg.Done()
				defer stop()
				terminal := a.execute(jobCtx, p, m, s, model)
				a.mu.Lock()
				s.active--
				a.mu.Unlock()
				attemptsMu.Lock()
				delete(active, m.AttemptID)
				attemptsMu.Unlock()
				// Cancellation acknowledgement follows response body closure and slot release.
				if p.Send(ctx, terminal) != nil {
					p.Close()
				}
			}(m, s, model)
		default:
			return errors.New("unexpected coordinator message")
		}
	}
}

// estimateTextBytes counts model text in a backend response chunk while
// ignoring SSE framing and JSON metadata. It is used only for live display;
// completed requests use the provider-reported usage values.
func estimateTextBytes(p []byte) int64 {
	var total int64
	for _, line := range bytes.Split(p, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if bytes.HasPrefix(line, []byte("data:")) {
			line = bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
		}
		if len(line) == 0 || bytes.Equal(line, []byte("[DONE]")) {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					Reasoning string `json:"reasoning"`
				} `json:"delta"`
				Message struct {
					Content   string `json:"content"`
					Reasoning string `json:"reasoning"`
				} `json:"message"`
			} `json:"choices"`
		}
		if json.Unmarshal(line, &chunk) != nil {
			continue
		}
		for _, choice := range chunk.Choices {
			total += int64(len([]byte(choice.Delta.Content)) + len([]byte(choice.Delta.Reasoning)) + len([]byte(choice.Message.Content)) + len([]byte(choice.Message.Reasoning)))
		}
	}
	return total
}

func (a *Agent) reserve(m protocol.Message) (*slot, string, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var body map[string]json.RawMessage
	if json.Unmarshal(m.Body, &body) != nil || body == nil {
		return nil, "", "invalid_request"
	}
	for _, s := range a.slots {
		if s.catalog.ID != m.BackendID {
			continue
		}
		if !s.catalog.Ready {
			return nil, "", "backend_unavailable"
		}
		for _, model := range s.catalog.Models {
			if model.ID != m.Model {
				continue
			}
			if s.active >= s.catalog.Capacity {
				return nil, "", "busy"
			}
			s.active++
			return s, model.Name, ""
		}
	}
	return nil, "", "model_not_allowed"
}

func (a *Agent) execute(ctx context.Context, p *wire.Peer, m protocol.Message, s *slot, model string) (terminal protocol.Message) {
	started := time.Now()
	var count int64
	terminal = protocol.Message{Type: "error", AttemptID: m.AttemptID, Code: "backend_failed", Retryable: true}
	defer func() {
		if ctx.Err() != nil {
			terminal.Type = "error"
			terminal.Code = "cancelled"
			terminal.Retryable = false
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				terminal.Code = "deadline_exceeded"
				terminal.Retryable = true
			}
		}
		a.logger.Info("attempt finished", "request_id", m.RequestID, "attempt_id", m.AttemptID, "backend_id", m.BackendID, "duration_ms", time.Since(started).Milliseconds(), "bytes", count, "result", terminal.Type, "code", terminal.Code, "usage", string(terminal.Usage))
		a.emit(AttemptEvent{RequestID: m.RequestID, AttemptID: m.AttemptID, BackendID: m.BackendID, Model: model, Type: terminal.Type, Code: terminal.Code, Duration: time.Since(started), Usage: append(json.RawMessage(nil), terminal.Usage...)})
	}()
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	startLimit := min(time.Duration(m.StartTimeoutMS)*time.Millisecond, time.Duration(a.config.StartTimeoutSeconds)*time.Second)
	var startExpired atomic.Bool
	timer := time.AfterFunc(startLimit, func() { startExpired.Store(true); cancel() })
	resp, err := s.runtime.Chat(requestCtx, m.Body, model)
	timer.Stop()
	if resp != nil {
		defer resp.Body.Close()
	}
	if startExpired.Load() {
		terminal.Code = "start_timeout"
		return
	}
	if err != nil {
		return
	}
	if resp.StatusCode >= 400 {
		// Error bodies can echo upstream credentials or private endpoints.
		// Carry only the HTTP status; the gateway supplies a safe error body.
		if p.Send(ctx, protocol.Message{Type: "response_start", AttemptID: m.AttemptID, Status: resp.StatusCode, ContentType: "application/json"}) == nil {
			terminal.Type = "response_end"
			terminal.Code = ""
			terminal.Retryable = false
		}
		return
	}
	contentType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if contentType != "text/event-stream" && contentType != "application/json" {
		terminal.Code = "invalid_backend_response"
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode > 599 {
		terminal.Code = "invalid_backend_response"
		return
	}
	if err = p.Send(ctx, protocol.Message{Type: "response_start", AttemptID: m.AttemptID, Status: resp.StatusCode, ContentType: contentType}); err != nil {
		return
	}
	a.emit(AttemptEvent{RequestID: m.RequestID, AttemptID: m.AttemptID, BackendID: m.BackendID, Model: model, Type: "response_start"})
	observer := backend.Observer{Stream: contentType == "text/event-stream"}
	buf := make([]byte, protocol.ChunkBytes)
	var seq uint64
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			observer.Feed(buf[:n])
			seq++
			if p.Send(ctx, protocol.Message{Type: "response_chunk", AttemptID: m.AttemptID, Seq: seq, Data: append([]byte(nil), buf[:n]...)}) != nil {
				return
			}
			count += int64(n)
			a.emit(AttemptEvent{RequestID: m.RequestID, AttemptID: m.AttemptID, BackendID: m.BackendID, Model: model, Type: "response_chunk", Bytes: int64(n), TextBytes: estimateTextBytes(buf[:n]), Duration: time.Since(started)})
		}
		if readErr != nil {
			observer.Finish()
			terminal.Usage = observer.Usage
			if readErr != io.EOF {
				terminal.Code = "stream_interrupted"
				return
			}
			if observer.Stream && resp.StatusCode < 300 && (!observer.Done || observer.Failed) {
				terminal.Code = "stream_interrupted"
				return
			}
			terminal.Type = "response_end"
			terminal.Code = ""
			terminal.Retryable = false
			return
		}
	}
}
