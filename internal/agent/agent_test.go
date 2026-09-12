package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"relay/internal/config"
	"relay/internal/wire"
	"relay/protocol"
)

func testSession(t *testing.T, chat http.HandlerFunc) (*wire.Peer, <-chan error) {
	t.Helper()
	t.Setenv("TEST_AGENT_TOKEN", "host-key")
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			fmt.Fprint(w, `{"models":[{"name":"echo","digest":"digest"}]}`)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		chat(w, r)
	}))
	t.Cleanup(backend.Close)
	ctx, cancel := context.WithCancel(context.Background())
	peers := make(chan *wire.Peer, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		p := wire.New(ctx, conn)
		m, err := p.Read(ctx)
		if err != nil || m.Type != "hello" {
			p.Close()
			return
		}
		if p.Send(ctx, protocol.Message{Type: "welcome", HostID: m.HostID}) != nil {
			p.Close()
			return
		}
		peers <- p
		<-ctx.Done()
		p.Close()
	}))
	t.Cleanup(server.Close)
	a, err := New(config.Agent{CoordinatorURL: "ws" + strings.TrimPrefix(server.URL, "http") + protocol.ConnectPath, HostID: "test", TokenEnv: "TEST_AGENT_TOKEN", Backends: []config.Backend{{ID: "ollama", Kind: "ollama", URL: backend.URL, Models: []string{"echo"}}}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	a.Discover(ctx)
	done := make(chan error, 1)
	go func() { done <- a.session(ctx) }()
	t.Cleanup(func() { cancel(); a.Close() })
	select {
	case p := <-peers:
		return p, done
	case <-time.After(3 * time.Second):
		t.Fatal("agent did not register")
		return nil, nil
	}
}

func assignment(id string) protocol.Message {
	return protocol.Message{Type: "request", RequestID: "request-" + id, AttemptID: id, BackendID: "ollama", Model: "ollama/echo", TimeoutMS: 2000, StartTimeoutMS: 1000, Body: json.RawMessage(`{"model":"ollama/echo","messages":[{"role":"user","content":"hi"}]}`)}
}

func readUntil(t *testing.T, p *wire.Peer, id, kind string) protocol.Message {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		m, err := p.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if m.AttemptID == id && m.Type == kind {
			return m
		}
	}
}

func TestDuplicateAttemptNeverReexecutes(t *testing.T) {
	var calls atomic.Int32
	p, done := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[]}`)
	})
	if err := p.Send(context.Background(), assignment("same")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, p, "same", "response_end")
	if err := p.Send(context.Background(), assignment("same")); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("duplicate not rejected")
		}
	case <-time.After(time.Second):
		t.Fatal("duplicate session remained open")
	}
	if calls.Load() != 1 {
		t.Fatal("duplicate request executed")
	}
}

func TestBusyDisallowedModelAndCancellationAcknowledgement(t *testing.T) {
	cancelled := make(chan struct{}, 1)
	p, _ := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		cancelled <- struct{}{}
	})
	ctx := context.Background()
	bad := assignment("bad")
	bad.Model = "ollama/private"
	if err := p.Send(ctx, bad); err != nil {
		t.Fatal(err)
	}
	if m := readUntil(t, p, "bad", "error"); m.Code != "model_not_allowed" {
		t.Fatal(m)
	}
	if err := p.Send(ctx, assignment("active")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, p, "active", "response_start")
	if err := p.Send(ctx, assignment("excess")); err != nil {
		t.Fatal(err)
	}
	if m := readUntil(t, p, "excess", "error"); m.Code != "busy" {
		t.Fatal(m)
	}
	if err := p.Send(ctx, protocol.Message{Type: "cancel", AttemptID: "active"}); err != nil {
		t.Fatal(err)
	}
	if m := readUntil(t, p, "active", "error"); m.Code != "cancelled" {
		t.Fatal(m)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("ack without HTTP cancellation")
	}
	// A fresh attempt is accepted after cancellation acknowledgement.
	if err := p.Send(ctx, assignment("next")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, p, "next", "response_start")
}

func TestResponseStartDeadlineCancelsHTTP(t *testing.T) {
	cancelled := make(chan struct{}, 1)
	p, _ := testSession(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done(); cancelled <- struct{}{} })
	m := assignment("timeout")
	m.StartTimeoutMS = 50
	if err := p.Send(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if result := readUntil(t, p, "timeout", "error"); result.Code != "start_timeout" {
		t.Fatal(result)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("timed-out HTTP request still running")
	}
}

func TestMissingHeartbeatAcknowledgementsClosesSession(t *testing.T) {
	p, done := testSession(t, func(w http.ResponseWriter, r *http.Request) {})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	m, err := p.Read(ctx)
	if err != nil || m.Type != "heartbeat" {
		t.Fatalf("heartbeat: %v %v", m, err)
	}
	// No heartbeat_ack is sent back.
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("agent did not expire its coordinator connection")
	}
}
