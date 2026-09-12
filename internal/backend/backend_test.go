package backend

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"relay/internal/config"
)

func TestCredentialIsolationAndNoRedirect(t *testing.T) {
	t.Setenv("TEST_PROXY_KEY", "private-key")
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls.Add(1) }))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-key" {
			t.Error("missing local credential")
		}
		http.Redirect(w, r, destination.URL, 307)
	}))
	defer origin.Close()
	r := New(config.Backend{ID: "proxy", Kind: "cliproxyapi", URL: origin.URL, KeyEnv: "TEST_PROXY_KEY", Models: []string{"echo"}, Concurrency: 1})
	defer r.Close()
	if _, err := r.Discover(context.Background()); err == nil {
		t.Fatal("redirect accepted")
	}
	if destinationCalls.Load() != 0 {
		t.Fatal("credential followed redirect")
	}
	if _, err := loopbackDial(context.Background(), "tcp", "192.0.2.1:80"); err == nil {
		t.Fatal("non-loopback accepted")
	}
}

func TestRemoteModelsAndExplicitAllowlist(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"models":[{"name":"local","digest":"abc"},{"name":"remote","digest":"def","remote_model":"upstream"},{"name":"other","digest":"ghi"}]}`)
	}))
	defer s.Close()
	r := New(config.Backend{ID: "ollama", Kind: "ollama", URL: s.URL, Models: []string{"local", "remote"}, Concurrency: 1})
	defer r.Close()
	b, err := r.Discover(context.Background())
	if err != nil || len(b.Models) != 1 || b.Models[0].Name != "local" {
		t.Fatalf("unexpected catalog %+v %v", b, err)
	}
}

func TestUsageObserverFragmentationAndBounds(t *testing.T) {
	o := Observer{Stream: true}
	p := "data: {\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":6,\"secret\":\"do-not-copy\"}}\r\n\r\ndata: [DONE]\n\n"
	for _, b := range []byte(p) {
		o.Feed([]byte{b})
	}
	if !o.Done || !strings.Contains(string(o.Usage), `"completion_tokens":6`) || strings.Contains(string(o.Usage), "secret") {
		t.Fatalf("invalid usage %s", o.Usage)
	}
	o = Observer{Stream: true}
	o.Feed([]byte("data: " + strings.Repeat("x", 2<<20) + "\n\ndata: [DONE]\n\n"))
	if !o.Done || len(o.buffer) > 64<<10 || len(o.event) > 64<<10 {
		t.Fatal("observer failed to recover after oversized event")
	}
	n := Observer{}
	n.Feed([]byte(`{"usage":{"total_tokens":0}}`))
	n.Finish()
	if string(n.Usage) != `{"total_tokens":0}` {
		t.Fatal("zero usage lost")
	}
	empty := Observer{}
	empty.Feed([]byte(`{"choices":[]}`))
	empty.Finish()
	if empty.Usage != nil {
		t.Fatal("missing usage invented")
	}
}
