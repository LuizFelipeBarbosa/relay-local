// Package protocol defines the versioned host/coordinator wire contract.
package protocol

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

const (
	Version           = 1
	ConnectPath       = "/relay/v1/connect"
	MaxRequestBytes   = 1 << 20
	MaxFrameBytes     = MaxRequestBytes + (64 << 10)
	ChunkBytes        = 32 << 10
	QueueBytes        = 256 << 10
	HeartbeatInterval = 5 * time.Second
	HeartbeatTimeout  = 10 * time.Second
	WriteTimeout      = 5 * time.Second
	StartTimeout      = 120 * time.Second
	TotalTimeout      = 10 * time.Minute
)

type Model struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Digest string `json:"digest,omitempty"`
}

type Backend struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Source    string  `json:"source"`
	Ready     bool    `json:"ready"`
	Capacity  int     `json:"capacity"`
	Available int     `json:"available"`
	Models    []Model `json:"models"`
}

// Message uses a small fixed envelope. Body and Usage retain provider JSON;
// Data encodes arbitrary response bytes as base64, never as token strings.
type Message struct {
	Version        int             `json:"version"`
	Type           string          `json:"type"`
	HostID         string          `json:"host_id,omitempty"`
	AgentVersion   string          `json:"agent_version,omitempty"`
	OS             string          `json:"os,omitempty"`
	Arch           string          `json:"arch,omitempty"`
	Backends       []Backend       `json:"backends,omitempty"`
	HeartbeatID    uint64          `json:"heartbeat_id,omitempty"`
	RequestID      string          `json:"request_id,omitempty"`
	AttemptID      string          `json:"attempt_id,omitempty"`
	BackendID      string          `json:"backend_id,omitempty"`
	Model          string          `json:"model,omitempty"`
	TimeoutMS      int64           `json:"timeout_ms,omitempty"`
	StartTimeoutMS int64           `json:"start_timeout_ms,omitempty"`
	Body           json.RawMessage `json:"body,omitempty"`
	Status         int             `json:"status,omitempty"`
	ContentType    string          `json:"content_type,omitempty"`
	Seq            uint64          `json:"seq,omitempty"`
	Data           []byte          `json:"data,omitempty"`
	Code           string          `json:"code,omitempty"`
	Retryable      bool            `json:"retryable,omitempty"`
	Usage          json.RawMessage `json:"usage,omitempty"`
}

func ID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func (m Message) Validate() error {
	if m.Version != Version {
		return errors.New("unsupported protocol version")
	}
	if len(m.RequestID) > 128 || len(m.HostID) > 64 || len(m.Code) > 64 || len(m.BackendID) > 64 || len(m.Model) > 512 {
		return errors.New("oversized identifier")
	}
	if len(m.Usage) > 0 {
		var usage map[string]int64
		if json.Unmarshal(m.Usage, &usage) != nil || usage == nil {
			return errors.New("invalid usage")
		}
		for key, n := range usage {
			if n < 0 || (key != "prompt_tokens" && key != "completion_tokens" && key != "total_tokens") {
				return errors.New("invalid usage")
			}
		}
	}
	switch m.Type {
	case "hello", "welcome":
		if m.HostID == "" {
			return errors.New("missing host identity")
		}
	case "catalog":
	case "heartbeat", "heartbeat_ack":
		if m.HeartbeatID == 0 {
			return errors.New("missing heartbeat ID")
		}
	case "request":
		if m.RequestID == "" || m.BackendID == "" || m.Model == "" || m.TimeoutMS < 1 || m.TimeoutMS > 86400000 || m.StartTimeoutMS < 1 || m.StartTimeoutMS > m.TimeoutMS || len(m.Body) > MaxRequestBytes || !json.Valid(m.Body) {
			return errors.New("invalid request")
		}
	case "response_start":
		if m.Status < 200 || m.Status > 599 || (m.ContentType != "text/event-stream" && m.ContentType != "application/json") {
			return errors.New("invalid response start")
		}
	case "response_chunk":
		if len(m.Data) == 0 || len(m.Data) > ChunkBytes || m.Seq == 0 {
			return errors.New("invalid response chunk")
		}
	case "response_end", "cancel":
	case "error":
		if m.Code == "" {
			return errors.New("missing error code")
		}
	default:
		return errors.New("unknown message type")
	}
	switch m.Type {
	case "request", "response_start", "response_chunk", "response_end", "error", "cancel":
		if m.AttemptID == "" || len(m.AttemptID) > 128 {
			return errors.New("missing or invalid attempt ID")
		}
	}
	return nil
}

func ValidateCatalog(backends []Backend) error {
	if len(backends) > 64 {
		return errors.New("too many backends")
	}
	ids := map[string]bool{}
	for _, b := range backends {
		if b.ID == "" || ids[b.ID] || b.Capacity < 1 || b.Capacity > 64 || b.Available < 0 || b.Available > b.Capacity || len(b.Models) > 1024 {
			return errors.New("invalid backend")
		}
		if (b.Kind != "ollama" || b.Source != "local") && (b.Kind != "cliproxyapi" || b.Source != "provider") {
			return errors.New("invalid backend source")
		}
		ids[b.ID] = true
		models := map[string]bool{}
		for _, m := range b.Models {
			if m.ID != b.ID+"/"+m.Name || m.Name == "" || models[m.ID] || (b.Source == "local" && m.Digest == "") {
				return errors.New("invalid model identity")
			}
			models[m.ID] = true
		}
	}
	return nil
}
