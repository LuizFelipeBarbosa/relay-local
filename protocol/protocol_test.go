package protocol

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedConformanceFixtures(t *testing.T) {
	data, err := os.ReadFile("../docs/protocol-examples.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Valid   []Message `json:"valid"`
		Invalid []Message `json:"invalid"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, m := range fixtures.Valid {
		if err := m.Validate(); err != nil {
			t.Errorf("valid %s: %v", m.Type, err)
		}
		if m.Type == "hello" || m.Type == "catalog" {
			if err := ValidateCatalog(m.Backends); err != nil {
				t.Error(err)
			}
		}
	}
	for _, m := range fixtures.Invalid {
		if m.Validate() == nil {
			t.Errorf("invalid %s was accepted", m.Type)
		}
	}
}

func TestRejectInvalidWireMessages(t *testing.T) {
	for _, m := range []Message{
		{Version: 2, Type: "hello", HostID: "one"},
		{Version: 1, Type: "request", AttemptID: "id", Body: json.RawMessage(`{}`)},
		{Version: 1, Type: "response_chunk", AttemptID: "id", Seq: 1, Data: make([]byte, ChunkBytes+1)},
		{Version: 1, Type: "response_chunk", AttemptID: "id", Data: []byte("missing sequence")},
		{Version: 1, Type: "response_end", AttemptID: "id", Usage: json.RawMessage(`{"secret":"not-usage"}`)},
		{Version: 1, Type: "heartbeat"},
	} {
		if m.Validate() == nil {
			t.Errorf("accepted invalid %s", m.Type)
		}
	}
}
