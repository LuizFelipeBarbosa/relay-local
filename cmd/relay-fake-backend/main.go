// relay-fake-backend provides deterministic, credential-free integration data.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"time"

	"relay/internal/config"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:11435", "loopback listen address")
	flag.Parse()
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || !config.LoopbackName(host) {
		panic("fake backend must listen on loopback")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/tags", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"models":[{"name":"fake","digest":"fake-digest-v1"}]}`)
	})
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"object":"list","data":[{"id":"fake"}]}`)
	})
	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream bool `json:"stream"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		if !body.Stream {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"fake","object":"chat.completion","model":"fake","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from Relay."},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, piece := range []string{"Hello ", "from ", "Relay."} {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
			p, _ := json.Marshal(map[string]any{"id": "fake", "object": "chat.completion.chunk", "model": "fake", "choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": piece}, "finish_reason": nil}}})
			fmt.Fprintf(w, "data: %s\n\n", p)
			w.(http.Flusher).Flush()
		}
		fmt.Fprint(w, "data: {\"id\":\"fake\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"total_tokens\":7}}\n\ndata: [DONE]\n\n")
	})
	fmt.Println("Fake inference backend:", *listen)
	if err := http.ListenAndServe(*listen, mux); err != nil {
		panic(err)
	}
}
