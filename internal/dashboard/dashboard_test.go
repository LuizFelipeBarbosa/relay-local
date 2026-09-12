package dashboard

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"relay/internal/config"
)

func TestDashboardSessionAndAvailability(t *testing.T) {
	dir := t.TempDir()
	c := config.Agent{CoordinatorURL: "ws://127.0.0.1:8080/relay/v1/connect", HostID: "test-host", TokenEnv: "TEST_TOKEN", Backends: []config.Backend{{ID: "ollama", Kind: "ollama", URL: "http://127.0.0.1:11434", Models: []string{"echo"}}}}
	m, err := New(c, filepath.Join(dir, "relay.json"), dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	h := m.Handler(context.Background())
	unauth := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:7331/api/v1/status", nil)
	unauth.Host = "127.0.0.1:7331"
	unauthResponse := httptest.NewRecorder()
	h.ServeHTTP(unauthResponse, unauth)
	if unauthResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d", unauthResponse.Code)
	}
	auth := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:7331/api/v1/session", nil)
	auth.Host = "127.0.0.1:7331"
	// The dashboard token is only accepted in a JSON body and never returned by APIs.
	auth = httptest.NewRequest(http.MethodPost, "http://127.0.0.1:7331/api/v1/session", strings.NewReader(`{"token":"bad"}`))
	auth.Host = "127.0.0.1:7331"
	response := httptest.NewRecorder()
	h.ServeHTTP(response, auth)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("bad token status = %d", response.Code)
	}
}
