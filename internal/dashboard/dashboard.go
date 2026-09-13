// Package dashboard provides the local command center and managed host lifecycle.
package dashboard

import (
	"bufio"
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"relay/internal/agent"
	"relay/internal/config"
	"relay/internal/history"
	"relay/internal/installer"
	"relay/internal/metrics"
)

//go:embed web/*
var assets embed.FS

type Managed struct {
	mu       sync.RWMutex
	config   config.Agent
	path     string
	logger   *slog.Logger
	agent    *agent.Agent
	cancel   context.CancelFunc
	runCtx   context.Context
	running  bool
	started  time.Time
	token    string
	stateDir string
	jobsMu   sync.RWMutex
	jobs     map[string]*ModelJob
	history  *history.Store
	activeMu sync.Mutex
	active   map[string]*liveAttempt
}

type liveAttempt struct {
	Model     string
	Bytes     int64
	TextBytes int64
}

type ModelJob struct {
	ID       string `json:"id"`
	Model    string `json:"model"`
	Status   string `json:"status"`
	Progress int    `json:"progress"`
	Error    string `json:"error,omitempty"`
}

type Status struct {
	HostID       string `json:"host_id"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	Running      bool   `json:"running"`
	Sharing      bool   `json:"sharing"`
	StartedAt    string `json:"started_at,omitempty"`
	Dashboard    string `json:"dashboard"`
	TokenPresent bool   `json:"token_present"`
}

func New(c config.Agent, path, stateDir string, logger *slog.Logger) (*Managed, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if stateDir == "" {
		stateDir = filepath.Dir(path)
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, err
	}
	token, err := dashboardToken(filepath.Join(stateDir, "dashboard.token"))
	if err != nil {
		return nil, err
	}
	a, err := agent.New(c, logger)
	if err != nil {
		return nil, err
	}
	store, _ := history.Open(filepath.Join(stateDir, "history.db"))
	m := &Managed{config: c, path: path, stateDir: stateDir, token: token, agent: a, logger: logger, jobs: map[string]*ModelJob{}, history: store, active: map[string]*liveAttempt{}}
	a.SetEventHandler(m.recordAttempt)
	return m, nil
}

func dashboardToken(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 20 {
		return strings.TrimSpace(string(b)), nil
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw[:])
	if err := os.WriteFile(path, []byte(token+"\n"), 0600); err != nil {
		return "", err
	}
	return token, nil
}

func (m *Managed) Token() string { return m.token }

func (m *Managed) AccessURL(addr string) string {
	if addr == "" {
		addr = "127.0.0.1:7331"
	}
	return "http://" + addr + "/?token=" + m.token
}

func (m *Managed) Start(ctx context.Context) {
	m.mu.Lock()
	if m.running || !m.config.Availability.Enabled || m.config.Availability.Paused {
		m.mu.Unlock()
		return
	}
	child, cancel := context.WithCancel(ctx)
	m.cancel, m.runCtx, m.running, m.started = cancel, ctx, true, time.Now()
	a := m.agent
	m.mu.Unlock()
	go func() {
		_ = a.Run(child)
		m.mu.Lock()
		m.running = false
		m.cancel = nil
		m.runCtx = nil
		m.mu.Unlock()
	}()
}

func (m *Managed) Pause(immediate bool) {
	m.mu.Lock()
	m.config.Availability.Paused = true
	cancel := m.cancel
	m.mu.Unlock()
	if immediate && cancel != nil {
		cancel()
	}
	_ = m.save()
	if m.history != nil {
		_ = m.history.Record(history.Event{Kind: "pause", Status: map[bool]string{true: "stop", false: "pause"}[immediate]})
	}
}

func (m *Managed) Resume(ctx context.Context) {
	m.mu.Lock()
	m.config.Availability.Enabled = true
	m.config.Availability.Paused = false
	m.mu.Unlock()
	_ = m.save()
	if m.history != nil {
		_ = m.history.Record(history.Event{Kind: "resume", Status: "sharing"})
	}
	m.Start(ctx)
}

func (m *Managed) Close() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	m.runCtx = nil
	m.mu.Unlock()
	m.agent.Close()
	if m.history != nil {
		_ = m.history.Close()
	}
}

func (m *Managed) save() error {
	m.mu.RLock()
	c := m.config
	path := m.path
	m.mu.RUnlock()
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	encErr := json.NewEncoder(f).Encode(c)
	closeErr := f.Close()
	if encErr != nil {
		return encErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp, path)
}

func (m *Managed) status() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := Status{HostID: m.config.HostID, OS: runtime.GOOS, Arch: runtime.GOARCH, Running: m.running, Sharing: m.config.Availability.Enabled && !m.config.Availability.Paused, Dashboard: "http://127.0.0.1:7331", TokenPresent: m.token != ""}
	if !m.started.IsZero() {
		s.StartedAt = m.started.UTC().Format(time.RFC3339)
	}
	return s
}

func (m *Managed) Handler(ctx context.Context) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/session", m.session)
	mux.HandleFunc("/api/v1/status", m.auth(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, m.status()) }))
	mux.HandleFunc("/api/v1/metrics", m.auth(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, metrics.Read()) }))
	mux.HandleFunc("/api/v1/runtimes", m.auth(m.runtimes))
	mux.HandleFunc("/api/v1/history", m.auth(m.recentHistory))
	mux.HandleFunc("/api/v1/usage", m.auth(m.usage))
	mux.HandleFunc("/api/v1/models", m.auth(m.models))
	mux.HandleFunc("/api/v1/models/jobs", m.auth(m.modelJobs))
	mux.HandleFunc("/api/v1/models/install", m.auth(m.installModel))
	mux.HandleFunc("/api/v1/models/remove", m.auth(m.removeModel))
	mux.HandleFunc("/api/v1/config", m.auth(m.configuration))
	mux.HandleFunc("/api/v1/prices", m.auth(m.prices))
	mux.HandleFunc("/api/v1/availability", m.auth(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var input struct {
			Action string `json:"action"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil {
			writeError(w, http.StatusBadRequest, "invalid action")
			return
		}
		switch input.Action {
		case "pause":
			m.Pause(false)
		case "stop":
			m.Pause(true)
		case "resume":
			m.Resume(ctx)
		default:
			writeError(w, http.StatusBadRequest, "unknown action")
			return
		}
		writeJSON(w, m.status())
	}))
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]string{"status": "ok"}) })
	mux.HandleFunc("/", serveAsset)
	return hostOnly(mux)
}

func (m *Managed) runtimes(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	backends := append([]config.Backend(nil), m.config.Backends...)
	m.mu.RUnlock()
	result := make([]map[string]any, 0, len(backends)+1)
	result = append(result, map[string]any{"name": "ollama", "binary": installer.Detect("ollama"), "configured": true})
	for _, b := range backends {
		if b.Kind != "cliproxyapi" {
			continue
		}
		name := b.Label
		if name == "" {
			name = b.ID
		}
		result = append(result, map[string]any{"name": name, "id": b.ID, "endpoint": b.URL, "configured": true, "binary": installer.Detect("cliproxyapi")})
	}
	writeJSON(w, result)
}

func (m *Managed) modelJobs(w http.ResponseWriter, r *http.Request) {
	m.jobsMu.RLock()
	defer m.jobsMu.RUnlock()
	jobs := make([]*ModelJob, 0, len(m.jobs))
	for _, job := range m.jobs {
		copy := *job
		jobs = append(jobs, &copy)
	}
	writeJSON(w, jobs)
}

func (m *Managed) recentHistory(w http.ResponseWriter, r *http.Request) {
	if m.history == nil {
		writeJSON(w, map[string]any{"events": []any{}, "complete": false})
		return
	}
	events, err := m.history.Recent(100)
	if err != nil {
		writeJSON(w, map[string]any{"events": []any{}, "complete": false})
		return
	}
	writeJSON(w, map[string]any{"events": events, "complete": true})
}

func (m *Managed) usage(w http.ResponseWriter, r *http.Request) {
	if m.history == nil {
		writeJSON(w, map[string]any{"today": history.Summary{}, "lifetime": history.Summary{}, "complete": false})
		return
	}
	now := time.Now()
	today, todayErr := m.history.Summary(time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()))
	lifetime, lifetimeErr := m.history.Summary(time.Time{})
	if todayErr != nil || lifetimeErr != nil {
		writeJSON(w, map[string]any{"today": today, "lifetime": lifetime, "complete": false})
		return
	}
	m.activeMu.Lock()
	liveRequests, liveBytes, liveTextBytes := len(m.active), int64(0), int64(0)
	for _, attempt := range m.active {
		liveBytes += attempt.Bytes
		liveTextBytes += attempt.TextBytes
	}
	m.activeMu.Unlock()
	writeJSON(w, map[string]any{"today": today, "lifetime": lifetime, "live": map[string]any{
		"requests": liveRequests, "bytes": liveBytes, "output_tokens_estimate": liveTextBytes / 4,
	}, "complete": true})
}

func (m *Managed) recordAttempt(event agent.AttemptEvent) {
	if event.Type == "response_start" {
		m.activeMu.Lock()
		m.active[event.AttemptID] = &liveAttempt{Model: event.BackendID + "/" + event.Model}
		m.activeMu.Unlock()
		return
	}
	if event.Type == "response_chunk" {
		m.activeMu.Lock()
		if attempt := m.active[event.AttemptID]; attempt != nil {
			attempt.Bytes += event.Bytes
			attempt.TextBytes += event.TextBytes
		}
		m.activeMu.Unlock()
		return
	}
	m.activeMu.Lock()
	delete(m.active, event.AttemptID)
	m.activeMu.Unlock()
	if m.history == nil {
		return
	}
	var usage map[string]int64
	if len(event.Usage) > 0 && json.Unmarshal(event.Usage, &usage) != nil {
		usage = nil
	}
	input, inputOK := usage["prompt_tokens"]
	output, outputOK := usage["completion_tokens"]
	total, totalOK := usage["total_tokens"]
	status := "failed"
	if event.Type == "response_end" && event.Code == "" {
		status = "completed"
	}
	if err := m.history.Record(history.Event{
		Kind:          "request",
		Model:         event.BackendID + "/" + event.Model,
		Status:        status,
		DurationMS:    event.Duration.Milliseconds(),
		InputTokens:   input,
		OutputTokens:  output,
		TotalTokens:   total,
		UsageReported: inputOK || outputOK || totalOK,
		UsageComplete: inputOK && outputOK,
		TotalReported: totalOK,
	}); err != nil {
		m.logger.Warn("could not record request history", "kind", "request")
	}
}

func (m *Managed) installModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Model string `json:"model"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || input.Model == "" {
		writeError(w, http.StatusBadRequest, "model is required")
		return
	}
	m.mu.RLock()
	endpoint := ""
	for _, b := range m.config.Backends {
		if b.Kind == "ollama" {
			endpoint = b.URL
			break
		}
	}
	m.mu.RUnlock()
	if endpoint == "" {
		writeError(w, http.StatusNotFound, "Ollama is not configured")
		return
	}
	id := configID()
	job := &ModelJob{ID: id, Model: input.Model, Status: "queued"}
	m.jobsMu.Lock()
	m.jobs[id] = job
	m.jobsMu.Unlock()
	go m.pullModel(endpoint, job)
	copy := *job
	writeJSON(w, &copy)
}

func (m *Managed) pullModel(endpoint string, job *ModelJob) {
	requestBody, _ := json.Marshal(map[string]any{"name": job.Model, "stream": true})
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(endpoint, "/")+"/api/pull", strings.NewReader(string(requestBody)))
	if err != nil {
		m.finishJob(job, "failed", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		m.finishJob(job, "failed", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		m.finishJob(job, "failed", fmt.Errorf("Ollama returned status %d", resp.StatusCode))
		return
	}
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 8<<20))
	for scanner.Scan() {
		var progress struct {
			Status    string `json:"status"`
			Completed int64  `json:"completed"`
			Total     int64  `json:"total"`
		}
		if json.Unmarshal(scanner.Bytes(), &progress) != nil {
			continue
		}
		m.jobsMu.Lock()
		job.Status = progress.Status
		if progress.Total > 0 {
			job.Progress = int(progress.Completed * 100 / progress.Total)
		}
		m.jobsMu.Unlock()
	}
	if err := scanner.Err(); err != nil {
		m.finishJob(job, "failed", err)
		return
	}
	m.jobsMu.Lock()
	job.Status = "complete"
	job.Progress = 100
	m.jobsMu.Unlock()
}

func (m *Managed) finishJob(job *ModelJob, status string, err error) {
	m.jobsMu.Lock()
	job.Status = status
	if err != nil {
		job.Error = err.Error()
	}
	m.jobsMu.Unlock()
}

func (m *Managed) removeModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Model string `json:"model"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || input.Model == "" {
		writeError(w, http.StatusBadRequest, "model is required")
		return
	}
	m.mu.RLock()
	endpoint := ""
	for _, b := range m.config.Backends {
		if b.Kind == "ollama" {
			endpoint = b.URL
			break
		}
	}
	m.mu.RUnlock()
	if endpoint == "" {
		writeError(w, http.StatusNotFound, "Ollama is not configured")
		return
	}
	body, _ := json.Marshal(map[string]string{"name": input.Model})
	req, err := http.NewRequest(http.MethodDelete, strings.TrimRight(endpoint, "/")+"/api/delete", strings.NewReader(string(body)))
	if err != nil {
		writeError(w, 500, "could not create request")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeError(w, 502, "Ollama unavailable")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		writeError(w, resp.StatusCode, "Ollama rejected model removal")
		return
	}
	writeJSON(w, map[string]bool{"removed": true})
}

func configID() string { return fmt.Sprintf("job-%d", time.Now().UnixNano()) }

func (m *Managed) session(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || !secureEqual(input.Token, m.token) {
		writeError(w, http.StatusUnauthorized, "invalid dashboard token")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "relay_session", Value: m.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(w, map[string]bool{"authenticated": true})
}

func (m *Managed) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("relay_session")
		if err != nil || !secureEqual(cookie.Value, m.token) {
			writeError(w, http.StatusUnauthorized, "dashboard authentication required")
			return
		}
		if r.Method != http.MethodGet && r.Header.Get("Origin") != "http://127.0.0.1:7331" && r.Header.Get("Origin") != "http://localhost:7331" {
			writeError(w, http.StatusForbidden, "invalid request origin")
			return
		}
		next(w, r)
	}
}

func (m *Managed) models(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var input struct {
			BackendID string `json:"backend_id"`
			Model     string `json:"model"`
			Offer     bool   `json:"offer"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || input.BackendID == "" || input.Model == "" {
			writeError(w, http.StatusBadRequest, "invalid model offer")
			return
		}
		m.mu.Lock()
		matched := false
		for i := range m.config.Backends {
			b := &m.config.Backends[i]
			if b.ID != input.BackendID {
				continue
			}
			found := false
			for _, model := range b.Models {
				if model == input.Model {
					found = true
				}
			}
			if input.Offer && !found {
				b.Models = append(b.Models, input.Model)
			}
			if !input.Offer && found {
				next := b.Models[:0]
				for _, model := range b.Models {
					if model != input.Model {
						next = append(next, model)
					}
				}
				b.Models = next
			}
			matched = true
		}
		m.mu.Unlock()
		if !matched {
			writeError(w, http.StatusNotFound, "backend not found")
			return
		}
		m.mu.RLock()
		updated := m.config
		m.mu.RUnlock()
		if err := m.replaceConfig(updated); err != nil {
			writeError(w, http.StatusInternalServerError, "could not save model offer")
			return
		}
		writeJSON(w, map[string]bool{"saved": true})
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	inventory := m.agent.Inventory(r.Context())
	m.mu.RLock()
	offers := make(map[string]map[string]bool, len(m.config.Backends))
	for _, b := range m.config.Backends {
		offers[b.ID] = make(map[string]bool)
		for _, model := range b.Models {
			offers[b.ID][model] = true
		}
	}
	m.mu.RUnlock()
	writeJSON(w, map[string]any{"backends": inventory, "offers": offers})
}

func (m *Managed) configuration(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		m.mu.RLock()
		c := m.config
		m.mu.RUnlock()
		writeJSON(w, c)
		return
	}
	if r.Method != http.MethodPut {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var input config.Agent
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&input) != nil || input.Validate() != nil {
		writeError(w, http.StatusBadRequest, "invalid configuration")
		return
	}
	if err := m.replaceConfig(input); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	m.mu.RLock()
	c := m.config
	m.mu.RUnlock()
	writeJSON(w, c)
}

func (m *Managed) prices(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		m.mu.RLock()
		prices := m.config.Prices
		m.mu.RUnlock()
		if prices == nil {
			prices = map[string]config.Price{}
		}
		writeJSON(w, prices)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Model  string `json:"model"`
		Input  string `json:"input_per_million"`
		Output string `json:"output_per_million"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || input.Model == "" {
		writeError(w, http.StatusBadRequest, "model is required")
		return
	}
	m.mu.Lock()
	if m.config.Prices == nil {
		m.config.Prices = map[string]config.Price{}
	}
	m.config.Prices[input.Model] = config.Price{InputPerMillion: input.Input, OutputPerMillion: input.Output}
	updated := m.config
	m.mu.Unlock()
	if err := m.save(); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save price")
		return
	}
	writeJSON(w, updated.Prices)
}

func (m *Managed) replaceConfig(c config.Agent) error {
	m.mu.Lock()
	oldCancel := m.cancel
	wasRunning := m.running
	runCtx := m.runCtx
	m.config = c
	m.agent.Close()
	m.running = false
	m.cancel = nil
	m.runCtx = nil
	a, err := agent.New(c, m.logger)
	if err == nil {
		m.agent = a
	}
	m.mu.Unlock()
	if oldCancel != nil {
		oldCancel()
	}
	if err != nil {
		return err
	}
	if err := m.save(); err != nil {
		return err
	}
	if wasRunning && runCtx != nil {
		m.Start(runCtx)
	}
	return nil
}

func hostOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "[::1]") {
			writeError(w, http.StatusForbidden, "dashboard is loopback-only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func serveAsset(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
	if name == "." || name == "" {
		name = "index.html"
	}
	data, err := assets.ReadFile("web/" + name)
	if err != nil {
		data, err = assets.ReadFile("web/index.html")
	}
	if err != nil {
		http.Error(w, "dashboard asset missing", http.StatusNotFound)
		return
	}
	if strings.HasSuffix(name, ".css") {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	} else if strings.HasSuffix(name, ".js") {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	_, _ = w.Write(data)
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.WriteHeader(status)
	writeJSON(w, map[string]string{"error": message})
}

func secureEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var result byte
	for i := range a {
		result |= a[i] ^ b[i]
	}
	return result == 0
}

func ListenAndServe(ctx context.Context, m *Managed, addr string) error {
	server := &http.Server{Addr: addr, Handler: m.Handler(ctx), ReadHeaderTimeout: 5 * time.Second}
	go func() { <-ctx.Done(); _ = server.Shutdown(context.Background()) }()
	err := server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return fmt.Errorf("dashboard: %w", err)
}
