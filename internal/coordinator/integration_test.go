package coordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"relay/internal/agent"
	"relay/internal/config"
	"relay/internal/wire"
	"relay/protocol"
)

type logBuffer struct {
	sync.Mutex
	bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(p)
}
func (b *logBuffer) text() string { b.Lock(); defer b.Unlock(); return b.Buffer.String() }

type cluster struct {
	coordinator *Coordinator
	server      *httptest.Server
	logger      *slog.Logger
	logs        *logBuffer
}

func newCluster(t *testing.T, ids ...string) *cluster {
	t.Helper()
	t.Setenv("TEST_BUYER_KEY", "buyer-secret-never-log")
	c := config.Coordinator{BuyerTokenEnv: "TEST_BUYER_KEY", Hosts: map[string]string{}, StartTimeoutSeconds: 2, TotalTimeoutSeconds: 5}
	for _, id := range ids {
		env := "TEST_HOST_" + id
		t.Setenv(env, "secret-"+id)
		c.Hosts[id] = env
	}
	logs := &logBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	s, err := New(c, logger)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); server.Close() })
	return &cluster{s, server, logger, logs}
}

func fakeBackend(t *testing.T, digest string, chat http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/tags", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"models":[{"name":"echo","digest":%q},{"name":"cloud","digest":"remote","remote_host":"https://example.com"},{"name":"private","digest":"hidden"}]}`, digest)
	})
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[{"id":"echo"},{"id":"private"}]}`)
	})
	mux.HandleFunc("POST /v1/chat/completions", chat)
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func (c *cluster) startAgent(t *testing.T, id, url, kind string) func() {
	t.Helper()
	a, err := agent.New(config.Agent{CoordinatorURL: "ws" + strings.TrimPrefix(c.server.URL, "http") + protocol.ConnectPath, HostID: id, TokenEnv: "TEST_HOST_" + id, Backends: []config.Backend{{ID: kind, Kind: kind, URL: url, Models: []string{"echo", "cloud"}, Concurrency: 1}}}, c.logger)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Error(err)
				}
			case <-time.After(5 * time.Second):
				t.Error("agent did not shut down")
			}
			a.Close()
		})
	}
	t.Cleanup(stop)
	eventually(t, func() bool {
		c.coordinator.mu.Lock()
		defer c.coordinator.mu.Unlock()
		return c.coordinator.hosts[id] != nil
	})
	return stop
}

func eventually(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func (c *cluster) request(t *testing.T, ctx context.Context, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, "POST", c.server.URL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer buyer-secret-never-log")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func (c *cluster) idle() bool {
	c.coordinator.mu.Lock()
	defer c.coordinator.mu.Unlock()
	for _, h := range c.coordinator.hosts {
		if len(h.jobs) > 0 {
			return false
		}
	}
	return true
}

const chatBody = `{"model":"ollama/echo","messages":[{"role":"user","content":"private-prompt-do-not-log"}]}`
const streamBody = `{"model":"ollama/echo","stream":true,"messages":[{"role":"user","content":"hello"}]}`
const answer = `{"id":"response","choices":[{"message":{"content":"private-answer-do-not-log"}}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}`

func TestNonStreamingBothAdaptersAndPrivacy(t *testing.T) {
	for _, kind := range []string{"ollama", "cliproxyapi"} {
		t.Run(kind, func(t *testing.T) {
			c := newCluster(t, "one")
			var forwarded map[string]json.RawMessage
			b := fakeBackend(t, "digest", func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" {
					t.Error("buyer or host credential forwarded")
				}
				_ = json.NewDecoder(r.Body).Decode(&forwarded)
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, answer)
			})
			stop := c.startAgent(t, "one", b.URL, kind)
			body := strings.Replace(chatBody, "ollama/", kind+"/", 1)
			body = strings.TrimSuffix(body, "}") + `,"tools":[{"type":"function","function":{"name":"weather","parameters":{"type":"object"}}}],"provider_extension":{"keep":true}}`
			resp := c.request(t, context.Background(), body)
			data, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || resp.StatusCode != 200 || string(data) != answer {
				t.Fatalf("response status=%d body=%s error=%v", resp.StatusCode, data, err)
			}
			stop()
			if string(forwarded["model"]) != `"echo"` || len(forwarded["tools"]) == 0 || string(forwarded["provider_extension"]) != `{"keep":true}` {
				t.Fatalf("request lost fields: %v", forwarded)
			}
			for _, secret := range []string{"private-prompt-do-not-log", "private-answer-do-not-log", "buyer-secret-never-log", "secret-one"} {
				if strings.Contains(c.logs.text(), secret) {
					t.Errorf("logs contain %q", secret)
				}
			}
			if !strings.Contains(c.logs.text(), "prompt_tokens") {
				t.Error("usage not recorded")
			}
		})
	}
}

func TestStreamingPreservesBytesAndArrivesEarly(t *testing.T) {
	c := newCluster(t, "one")
	first := []byte("data: {\"choices\":[{\"delta\":{\"content\":\"hé🙂\"}}]}\r\n\r\n")
	rest := []byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"city\\\":\"}}]}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\ndata: [DONE]\n\n")
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	b := fakeBackend(t, "digest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, v := range first {
			_, _ = w.Write([]byte{v})
			w.(http.Flusher).Flush()
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write(rest)
	})
	c.startAgent(t, "one", b.URL, "ollama")
	resp := c.request(t, context.Background(), streamBody)
	defer resp.Body.Close()
	got := make([]byte, len(first))
	if _, err := io.ReadFull(resp.Body, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, first) {
		t.Fatalf("stream changed: %q", got)
	}
	once.Do(func() { close(release) })
	tail, err := io.ReadAll(resp.Body)
	if err != nil || !bytes.Equal(tail, rest) {
		t.Fatalf("tail changed: %q, %v", tail, err)
	}
	eventually(t, c.idle)
}

func TestBuyerCancelReleasesBackendAndCapacity(t *testing.T) {
	c := newCluster(t, "one")
	cancelled := make(chan struct{}, 1)
	b := fakeBackend(t, "digest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		cancelled <- struct{}{}
	})
	c.startAgent(t, "one", b.URL, "ollama")
	ctx, cancel := context.WithCancel(context.Background())
	resp := c.request(t, ctx, streamBody)
	cancel()
	resp.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("backend was not cancelled")
	}
	eventually(t, c.idle)
}

func TestRetryBeforeResponseAndDigestConstraint(t *testing.T) {
	for _, sameDigest := range []bool{true, false} {
		t.Run(fmt.Sprint(sameDigest), func(t *testing.T) {
			c := newCluster(t, "a", "b")
			var callsA, callsB atomic.Int32
			a := fakeBackend(t, "digest-a", func(w http.ResponseWriter, r *http.Request) {
				callsA.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(503)
				fmt.Fprint(w, `{"error":"unavailable"}`)
			})
			digest := "digest-a"
			if !sameDigest {
				digest = "digest-b"
			}
			b := fakeBackend(t, digest, func(w http.ResponseWriter, r *http.Request) {
				callsB.Add(1)
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, answer)
			})
			c.startAgent(t, "a", a.URL, "ollama")
			c.startAgent(t, "b", b.URL, "ollama")
			resp := c.request(t, context.Background(), chatBody)
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if callsA.Load() != 1 {
				t.Fatal("first host not called once")
			}
			if sameDigest {
				if callsB.Load() != 1 || resp.StatusCode != 200 || string(body) != answer {
					t.Fatalf("retry failed: %d %s", resp.StatusCode, body)
				}
			} else if callsB.Load() != 0 || resp.StatusCode != 503 {
				t.Fatal("retried onto a different model digest")
			}
		})
	}
}

func TestMidStreamFailureNeverRetries(t *testing.T) {
	c := newCluster(t, "a", "b")
	var other atomic.Int32
	a := fakeBackend(t, "digest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		w.(http.Flusher).Flush()
	})
	b := fakeBackend(t, "digest", func(w http.ResponseWriter, r *http.Request) {
		other.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, answer)
	})
	c.startAgent(t, "a", a.URL, "ollama")
	c.startAgent(t, "b", b.URL, "ollama")
	resp := c.request(t, context.Background(), streamBody)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if other.Load() != 0 || !strings.Contains(string(body), "partial") || !strings.Contains(string(body), "stream_interrupted") || strings.Contains(string(body), "[DONE]") {
		t.Fatalf("incorrect interrupted stream: %s", body)
	}
}

func TestCapacityAndGatewayValidation(t *testing.T) {
	c := newCluster(t, "one")
	b := fakeBackend(t, "digest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	c.startAgent(t, "one", b.URL, "ollama")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	active := c.request(t, ctx, streamBody)
	defer active.Body.Close()
	for _, test := range []struct {
		body   string
		status int
	}{{chatBody, 503}, {strings.Replace(chatBody, "ollama/echo", "ollama/cloud", 1), 503}, {strings.Replace(chatBody, "ollama/echo", "ollama/private", 1), 503}, {`{"model":"ollama/echo","messages":null}`, 400}, {strings.Repeat("x", protocol.MaxRequestBytes+1), 413}} {
		resp := c.request(t, context.Background(), test.body)
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != test.status {
			t.Errorf("status %d, want %d", resp.StatusCode, test.status)
		}
	}
	resp, err := http.Get(c.server.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Error("unauthenticated buyer accepted")
	}
	_, resp, err = websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(c.server.URL, "http")+protocol.ConnectPath, nil)
	if err == nil || resp.StatusCode != 401 {
		t.Fatal("unauthenticated host accepted")
	}
}

func TestReconnectRegistersFreshCapacity(t *testing.T) {
	c := newCluster(t, "one")
	b := fakeBackend(t, "digest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, answer)
	})
	c.startAgent(t, "one", b.URL, "ollama")
	c.coordinator.mu.Lock()
	old := c.coordinator.hosts["one"]
	c.coordinator.mu.Unlock()
	old.peer.Close()
	eventually(t, func() bool {
		c.coordinator.mu.Lock()
		defer c.coordinator.mu.Unlock()
		h := c.coordinator.hosts["one"]
		return h != nil && h != old
	})
	resp := c.request(t, context.Background(), chatBody)
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(data) != answer {
		t.Fatal("reconnected host failed")
	}
}

func rawHost(t *testing.T, c *cluster, id string) *wire.Peer {
	t.Helper()
	ctx := context.Background()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.server.URL, "http")+protocol.ConnectPath, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer secret-" + id}}})
	if err != nil {
		t.Fatal(err)
	}
	p := wire.New(ctx, conn)
	t.Cleanup(p.Close)
	if err := p.Send(ctx, protocol.Message{Type: "hello", HostID: id, Backends: []protocol.Backend{{ID: "ollama", Kind: "ollama", Source: "local", Ready: true, Capacity: 1, Available: 1, Models: []protocol.Model{{ID: "ollama/echo", Name: "echo", Digest: "digest"}}}}}); err != nil {
		t.Fatal(err)
	}
	if m, err := p.Read(ctx); err != nil || m.Type != "welcome" {
		t.Fatalf("welcome: %v %v", m, err)
	}
	return p
}

func TestSilentHostExpiresAndFailsPendingRequest(t *testing.T) {
	c := newCluster(t, "one")
	p := rawHost(t, c, "one")
	j := c.coordinator.selectJob("ollama/echo", "", nil)
	if j == nil {
		t.Fatal("no capacity")
	}
	c.coordinator.mu.Lock()
	h := c.coordinator.hosts["one"]
	c.coordinator.mu.Unlock()
	// Exercise the real expiry loop without a ten-second test delay.
	h.lastHeartbeat.Store(time.Now().Add(-protocol.HeartbeatTimeout).UnixNano())
	eventually(t, func() bool {
		c.coordinator.mu.Lock()
		defer c.coordinator.mu.Unlock()
		return c.coordinator.hosts["one"] == nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := p.Read(ctx); err == nil {
		t.Fatal("expired host connection remained open")
	}
	select {
	case code := <-j.failure:
		if code != "host_disconnected" {
			t.Fatal(code)
		}
	default:
		t.Fatal("pending request was not failed")
	}
}

func TestHostProtocolRejections(t *testing.T) {
	c := newCluster(t, "one")
	for _, data := range [][]byte{
		[]byte(`{"version":2,"type":"hello","host_id":"one"}`),
		[]byte(`{"version":1,"type":"hello","host_id":"impostor"}`),
		[]byte(`{"version":1,"type":"hello","host_id":"one","destination_url":"http://example.com"}`),
		[]byte(`{"version":1,"type":"hello","host_id":"one","agent_version":"` + strings.Repeat("x", protocol.MaxFrameBytes) + `"}`),
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.server.URL, "http")+protocol.ConnectPath, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer secret-one"}}})
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		_ = conn.Write(ctx, websocket.MessageText, data)
		if _, _, err := conn.Read(ctx); err == nil {
			t.Error("invalid registration accepted")
		}
		_ = conn.CloseNow()
		cancel()
	}
}

func TestSlowConsumerQueueIsBoundedAndCancels(t *testing.T) {
	c := newCluster(t, "one")
	p := rawHost(t, c, "one")
	j := c.coordinator.selectJob("ollama/echo", "", nil)
	if j == nil {
		t.Fatal("no job")
	}
	c.coordinator.deliver(j.host, protocol.Message{Type: "response_start", AttemptID: j.id, Status: 200, ContentType: "text/event-stream"})
	for i := 1; i <= 9; i++ {
		c.coordinator.deliver(j.host, protocol.Message{Type: "response_chunk", AttemptID: j.id, Seq: uint64(i), Data: make([]byte, protocol.ChunkBytes)})
	}
	if j.queued.Load() > protocol.QueueBytes || !j.dropping.Load() {
		t.Fatal("slow stream was not bounded")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	m, err := p.Read(ctx)
	if err != nil || m.Type != "cancel" {
		t.Fatalf("expected cancellation: %v %v", m, err)
	}
	if err := p.Send(ctx, protocol.Message{Type: "error", AttemptID: j.id, Code: "cancelled"}); err != nil {
		t.Fatal(err)
	}
	eventually(t, c.idle)
}
