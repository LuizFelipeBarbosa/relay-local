package coordinator

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"relay/internal/config"
	"relay/protocol"
)

// Exercise the cloud transport with certificate verification enabled. The test
// trusts only its fixture CA, in-process; it never changes the OS trust store.
func TestTLSCloudConnection(t *testing.T) {
	t.Setenv("TEST_BUYER_KEY", "buyer-secret-never-log")
	t.Setenv("TEST_HOST_one", "secret-one")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s, err := New(config.Coordinator{
		BuyerTokenEnv: "TEST_BUYER_KEY", Hosts: map[string]string{"one": "TEST_HOST_one"},
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(s.Handler())
	// Match the reference executable's body-read timeout. A hijacked
	// WebSocket must remain healthy beyond this HTTP timeout.
	server.Config.ReadTimeout = 30 * time.Second
	server.Config.ErrorLog = slog.NewLogLogger(slog.NewTextHandler(io.Discard, nil), slog.LevelError)
	server.StartTLS()
	t.Cleanup(func() { s.Close(); server.Close() })
	url := "wss" + strings.TrimPrefix(server.URL, "https") + protocol.ConnectPath

	t.Run("reject untrusted certificate", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		conn, response, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer secret-one"}}})
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response != nil {
			t.Fatal("untrusted certificate accepted")
		}
	})

	trusted := server.Client().Transport.(*http.Transport).Clone()
	trusted.TLSClientConfig.MinVersion = tls.VersionTLS12
	t.Cleanup(trusted.CloseIdleConnections)
	t.Run("reject wrong certificate hostname", func(t *testing.T) {
		transport := trusted.Clone()
		transport.TLSClientConfig.ServerName = "wrong-host.invalid"
		defer transport.CloseIdleConnections()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		conn, response, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: &http.Client{Transport: transport}, HTTPHeader: http.Header{"Authorization": []string{"Bearer secret-one"}}})
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response != nil {
			t.Fatal("certificate hostname mismatch accepted")
		}
	})

	t.Run("reject unauthenticated TLS client", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		conn, response, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: &http.Client{Transport: trusted}})
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatal("TLS host authentication was not enforced")
		}
	})

	// The production dialer uses the process's default HTTP transport. Give
	// that same code path a fixture trust root, with no verification bypass.
	previousTransport := http.DefaultTransport
	http.DefaultTransport = trusted
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	c := &cluster{coordinator: s, server: server, logger: logger}
	b := fakeBackend(t, "digest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"TLS works\"}}]}\n\n")
		w.(http.Flusher).Flush()
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	c.startAgent(t, "one", b.URL, "ollama")
	s.mu.Lock()
	original := s.hosts["one"]
	s.mu.Unlock()
	if original == nil {
		t.Fatal("TLS agent did not register")
	}

	// Cross several heartbeat cycles and the HTTP read timeout.
	timer := time.NewTimer(31 * time.Second)
	defer timer.Stop()
	select {
	case <-original.peer.Done():
		t.Fatal("TLS connection closed before the long-lived connection check")
	case <-timer.C:
	}
	s.mu.Lock()
	current := s.hosts["one"]
	s.mu.Unlock()
	if current != original {
		t.Fatal("host silently reconnected during the keepalive check")
	}
	response := c.request(t, context.Background(), streamBody)
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || !strings.Contains(string(body), "TLS works") || !strings.Contains(string(body), "[DONE]") {
		t.Fatalf("TLS inference failed: status=%d body=%q error=%v", response.StatusCode, body, err)
	}

	request, _ := http.NewRequest("POST", server.URL+"/v1/responses", strings.NewReader(`{"model":"ollama/echo","input":"Hello"}`))
	request.Header.Set("Authorization", "Bearer buyer-secret-never-log")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("unexpected /v1/responses status: %d", response.StatusCode)
	}
}
