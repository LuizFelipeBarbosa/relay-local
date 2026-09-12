package coordinator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"relay/protocol"
)

func (s *Coordinator) chat(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, protocol.MaxRequestBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		apiError(w, 413, "request_too_large")
		return
	}
	var request struct {
		Model    string          `json:"model"`
		Stream   bool            `json:"stream"`
		Messages json.RawMessage `json:"messages"`
	}
	if json.Unmarshal(body, &request) != nil || request.Model == "" || len(request.Messages) == 0 {
		apiError(w, 400, "invalid_request")
		return
	}
	var messages []json.RawMessage
	if json.Unmarshal(request.Messages, &messages) != nil || len(messages) == 0 {
		apiError(w, 400, "invalid_messages")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.config.TotalTimeoutSeconds)*time.Second)
	defer cancel()
	requestID := protocol.ID()
	w.Header().Set("X-Request-ID", requestID)
	var previous *job
	for attempt := 0; attempt < 2; attempt++ {
		excluded := ""
		if previous != nil {
			excluded = previous.host.id
		}
		j := s.selectJob(request.Model, excluded, previous)
		if j == nil {
			apiError(w, 503, "no_capacity")
			return
		}
		deadline, _ := ctx.Deadline()
		remaining := time.Until(deadline)
		if remaining < time.Millisecond {
			s.abandon(j)
			apiError(w, 504, "deadline_exceeded")
			return
		}
		startLimit := min(time.Duration(s.config.StartTimeoutSeconds)*time.Second, remaining)
		m := protocol.Message{Type: "request", RequestID: requestID, AttemptID: j.id, BackendID: j.backend.ID, Model: j.model.ID, TimeoutMS: remaining.Milliseconds(), StartTimeoutMS: startLimit.Milliseconds(), Body: body}
		if j.host.peer.Send(ctx, m) != nil {
			j.host.peer.Close()
			s.abandon(j)
			previous = j
			if attempt == 0 && ctx.Err() == nil {
				continue
			}
			apiError(w, 502, "host_disconnected")
			return
		}
		retry := s.forward(ctx, w, j, request.Stream, startLimit, attempt == 0, requestID)
		if !retry {
			return
		}
		previous = j
	}
}

func transient(status int) bool {
	return status == 408 || status == 429 || status == 500 || status == 502 || status == 503 || status == 504
}

// forward commits the buyer response only upon the first body chunk. After
// commitment, failures terminate that response and can never trigger a retry.
func (s *Coordinator) forward(ctx context.Context, w http.ResponseWriter, j *job, stream bool, startLimit time.Duration, canRetry bool, requestID string) bool {
	defer s.abandon(j)
	started := time.Now()
	var bytes int64
	status := 0
	committed := false
	var usage json.RawMessage
	result := "failed"
	defer func() {
		s.logger.Info("gateway attempt finished", "request_id", requestID, "attempt_id", j.id, "host_id", j.host.id, "duration_ms", time.Since(started).Milliseconds(), "bytes", bytes, "result", result, "usage", string(usage))
	}()
	timer := time.NewTimer(startLimit)
	defer timer.Stop()
	startExpired := timer.C
	rc := http.NewResponseController(w)
	// A cancelled request interrupts a blocked buyer write immediately.
	writeStopped := make(chan struct{})
	stopWrite := context.AfterFunc(ctx, func() { defer close(writeStopped); _ = rc.SetWriteDeadline(time.Now()) })
	defer func() {
		if !stopWrite() {
			<-writeStopped
		}
		_ = rc.SetWriteDeadline(time.Time{})
	}()
	fail := func(code string, retryable bool) bool {
		if !committed {
			if canRetry && retryable && ctx.Err() == nil {
				return true
			}
			status := 502
			if code == "deadline_exceeded" || code == "start_timeout" {
				status = 504
			}
			if ctx.Err() == nil || ctx.Err() == context.DeadlineExceeded {
				apiError(w, status, code)
			}
			return false
		}
		if stream {
			_ = rc.SetWriteDeadline(time.Now().Add(protocol.WriteTimeout))
			_, _ = io.WriteString(w, "\n\ndata: {\"error\":{\"type\":\"relay_error\",\"code\":\"stream_interrupted\",\"message\":\"stream interrupted\"}}\n\n")
			_ = rc.Flush()
			return false
		}
		// A partial JSON body must be an HTTP transport failure, never a
		// successful truncated JSON response followed by a second error body.
		panic(http.ErrAbortHandler)
	}
	for {
		select {
		case <-ctx.Done():
			return fail("deadline_exceeded", false)
		case <-startExpired:
			return fail("start_timeout", true)
		case code := <-j.failure:
			return fail(code, true)
		case m := <-j.events:
			j.queued.Add(-int64(len(m.Data)))
			switch m.Type {
			case "response_start":
				status = m.Status
				if transient(status) && canRetry {
					return true
				}
				if status >= 400 {
					// Backend error bodies can contain credentials or internal URLs.
					apiError(w, status, "backend_rejected")
					return false
				}
				if status >= 300 || (stream && m.ContentType != "text/event-stream") || (!stream && m.ContentType != "application/json") {
					return fail("invalid_backend_response", true)
				}
				timer.Stop()
				startExpired = nil
				w.Header().Set("Content-Type", m.ContentType)
				w.Header().Set("Cache-Control", "no-store")
				w.Header().Set("X-Accel-Buffering", "no")
			case "response_chunk":
				if status == 0 {
					return fail("invalid_backend_response", false)
				}
				_ = rc.SetWriteDeadline(time.Now().Add(protocol.WriteTimeout))
				if !committed {
					w.WriteHeader(status)
					committed = true
				}
				n, err := w.Write(m.Data)
				bytes += int64(n)
				if err != nil {
					return false
				}
				if err = rc.Flush(); err != nil {
					return false
				}
			case "response_end":
				usage = m.Usage
				if !committed {
					return fail("empty_backend_response", true)
				}
				result = "completed"
				return false
			case "error":
				usage = m.Usage
				// Only our documented codes become observable gateway errors.
				code := "backend_failed"
				switch m.Code {
				case "busy", "backend_unavailable", "model_not_allowed", "invalid_request", "start_timeout", "deadline_exceeded", "cancelled", "stream_interrupted", "invalid_backend_response":
					code = m.Code
				}
				return fail(code, m.Retryable)
			}
		}
	}
}
