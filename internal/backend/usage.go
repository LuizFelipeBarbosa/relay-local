package backend

import (
	"bytes"
	"encoding/json"
)

// Observer inspects a bounded copy for completion markers and usage only. It
// never rewrites or delays the bytes being forwarded to the buyer.
type Observer struct {
	Stream       bool
	Done         bool
	Failed       bool
	Usage        json.RawMessage
	buffer       []byte
	event        []byte
	discardLine  bool
	discardEvent bool
	overflow     bool
}

func (o *Observer) Feed(p []byte) {
	if !o.Stream {
		if o.overflow {
			return
		}
		if len(o.buffer)+len(p) > 1<<20 {
			o.buffer = nil
			o.overflow = true
			return
		}
		o.buffer = append(o.buffer, p...)
		return
	}
	for _, b := range p {
		if b == '\n' {
			if o.discardLine {
				o.discardEvent = true
			} else {
				o.line(bytes.TrimSuffix(o.buffer, []byte{'\r'}))
			}
			o.buffer = o.buffer[:0]
			o.discardLine = false
		} else if len(o.buffer) < 64<<10 {
			o.buffer = append(o.buffer, b)
		} else {
			o.discardLine = true
		}
	}
}

func (o *Observer) line(line []byte) {
	if len(line) == 0 {
		if !o.discardEvent {
			data := bytes.TrimSpace(o.event)
			if bytes.Equal(data, []byte("[DONE]")) {
				o.Done = true
			} else {
				o.observeJSON(data)
			}
		}
		o.event = o.event[:0]
		o.discardEvent = false
		return
	}
	if bytes.HasPrefix(line, []byte("data:")) {
		data := bytes.TrimPrefix(line, []byte("data:"))
		data = bytes.TrimPrefix(data, []byte(" "))
		if len(o.event)+len(data) > 64<<10 {
			o.discardEvent = true
			return
		}
		o.event = append(o.event, data...)
		o.event = append(o.event, '\n')
	}
}

func (o *Observer) Finish() {
	if !o.Stream && !o.overflow {
		o.observeJSON(o.buffer)
	}
}

func (o *Observer) observeJSON(p []byte) {
	var result struct {
		Usage map[string]json.RawMessage `json:"usage"`
		Error json.RawMessage            `json:"error"`
	}
	if json.Unmarshal(p, &result) != nil {
		return
	}
	if len(result.Error) > 0 && string(result.Error) != "null" {
		o.Failed = true
	}
	usage := map[string]int64{}
	for _, key := range []string{"prompt_tokens", "completion_tokens", "total_tokens"} {
		var n int64
		if value, ok := result.Usage[key]; ok && json.Unmarshal(value, &n) == nil && n >= 0 {
			usage[key] = n
		}
	}
	if len(usage) > 0 {
		o.Usage, _ = json.Marshal(usage)
	}
}
