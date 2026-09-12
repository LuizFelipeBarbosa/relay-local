// Package backend adapts installed inference services without managing processes.
package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"time"

	"relay/internal/config"
	"relay/protocol"
)

type Runtime struct {
	Config config.Backend
	client *http.Client
}

func New(c config.Backend) *Runtime {
	transport := &http.Transport{
		Proxy:               nil,
		DialContext:         loopbackDial,
		TLSHandshakeTimeout: 5 * time.Second,
		IdleConnTimeout:     30 * time.Second,
		MaxIdleConnsPerHost: c.Concurrency,
		DisableCompression:  true,
	}
	return &Runtime{Config: c, client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

// Resolve and dial the SAME validated IP, preventing DNS rebinding. No proxy
// environment variables or redirects can move backend credentials off-host.
func loopbackDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("invalid backend address")
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("backend DNS lookup failed")
	}
	for _, ip := range ips {
		if !ip.IP.IsLoopback() {
			return nil, errors.New("backend must resolve only to loopback")
		}
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if err == nil {
			return conn, nil
		}
	}
	return nil, errors.New("backend connection failed")
}

func (r *Runtime) Close() { r.client.CloseIdleConnections() }

func (r *Runtime) request(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, r.Config.URL+path, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("invalid backend request")
	}
	req.Header.Set("Content-Type", "application/json")
	if r.Config.KeyEnv != "" {
		key, err := config.Secret(r.Config.KeyEnv)
		if err != nil {
			return nil, errors.New("backend credential missing")
		}
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, errors.New("backend request failed")
	}
	return resp, nil
}

func (r *Runtime) Discover(ctx context.Context) (protocol.Backend, error) {
	return r.discover(ctx, false)
}

// DiscoverAll returns the runtime catalog before Relay's offer allowlist is applied.
func (r *Runtime) DiscoverAll(ctx context.Context) (protocol.Backend, error) {
	return r.discover(ctx, true)
}

func (r *Runtime) discover(ctx context.Context, includeAll bool) (protocol.Backend, error) {
	b := protocol.Backend{ID: r.Config.ID, Kind: r.Config.Kind, Capacity: r.Config.Concurrency, Available: r.Config.Concurrency, Models: []protocol.Model{}, Source: "provider"}
	path := "/v1/models"
	if b.Kind == "ollama" {
		path = "/api/tags"
		b.Source = "local"
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := r.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return b, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return b, errors.New("backend discovery rejected; check service and credentials")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, protocol.MaxRequestBytes+1))
	if err != nil || len(body) > protocol.MaxRequestBytes {
		return b, errors.New("invalid discovery response")
	}
	allowed := map[string]bool{}
	for _, name := range r.Config.Models {
		allowed[name] = true
	}
	seen := map[string]bool{}
	if b.Kind == "ollama" {
		var result struct {
			Models []struct {
				Name        string `json:"name"`
				Digest      string `json:"digest"`
				RemoteModel string `json:"remote_model"`
				RemoteHost  string `json:"remote_host"`
			} `json:"models"`
		}
		if json.Unmarshal(body, &result) != nil {
			return b, errors.New("invalid Ollama catalog")
		}
		for _, m := range result.Models {
			if (includeAll || allowed[m.Name]) && !seen[m.Name] && m.Digest != "" && m.RemoteModel == "" && m.RemoteHost == "" {
				b.Models = append(b.Models, protocol.Model{ID: b.ID + "/" + m.Name, Name: m.Name, Digest: m.Digest})
				seen[m.Name] = true
			}
		}
	} else {
		var result struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if json.Unmarshal(body, &result) != nil {
			return b, errors.New("invalid CLIProxyAPI catalog")
		}
		for _, m := range result.Data {
			if (includeAll || allowed[m.ID]) && !seen[m.ID] {
				b.Models = append(b.Models, protocol.Model{ID: b.ID + "/" + m.ID, Name: m.ID})
				seen[m.ID] = true
			}
		}
	}
	b.Ready = len(b.Models) > 0
	return b, nil
}

func (r *Runtime) Chat(ctx context.Context, body json.RawMessage, model string) (*http.Response, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return nil, errors.New("invalid chat request")
	}
	fields["model"], _ = json.Marshal(model)
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil, errors.New("invalid chat request")
	}
	return r.request(ctx, http.MethodPost, "/v1/chat/completions", encoded)
}
