// Package wire serializes writes, prioritizing control messages between chunks.
package wire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/coder/websocket"
	"relay/protocol"
)

type outbound struct {
	ctx     context.Context
	message protocol.Message
	done    chan error
}

type Peer struct {
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	control chan outbound
	data    chan outbound
}

func New(ctx context.Context, conn *websocket.Conn) *Peer {
	ctx, cancel := context.WithCancel(ctx)
	p := &Peer{conn: conn, ctx: ctx, cancel: cancel, control: make(chan outbound, 64), data: make(chan outbound, 64)}
	conn.SetReadLimit(protocol.MaxFrameBytes)
	go p.writeLoop()
	context.AfterFunc(ctx, func() { _ = conn.CloseNow() })
	return p
}

func (p *Peer) Close()                { p.cancel() }
func (p *Peer) Done() <-chan struct{} { return p.ctx.Done() }

func (p *Peer) Send(ctx context.Context, m protocol.Message) error {
	ctx, cancel := context.WithTimeout(ctx, protocol.WriteTimeout)
	defer cancel()
	m.Version = protocol.Version
	o := outbound{ctx: ctx, message: m, done: make(chan error, 1)}
	queue := p.control
	if m.Type == "response_chunk" {
		queue = p.data
	}
	select {
	case queue <- o:
	case <-ctx.Done():
		return ctx.Err()
	case <-p.ctx.Done():
		return p.ctx.Err()
	}
	select {
	case err := <-o.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-p.ctx.Done():
		return p.ctx.Err()
	}
}

func (p *Peer) writeLoop() {
	defer p.Close()
	for {
		var o outbound
		select {
		case o = <-p.control:
		default:
			select {
			case o = <-p.control:
			case o = <-p.data:
			case <-p.ctx.Done():
				return
			}
		}
		if o.ctx.Err() != nil {
			o.done <- o.ctx.Err()
			continue
		}
		b, err := json.Marshal(o.message)
		if err == nil {
			err = p.conn.Write(o.ctx, websocket.MessageText, b)
		}
		o.done <- err
		if err != nil {
			return
		}
	}
}

func (p *Peer) Read(ctx context.Context) (protocol.Message, error) {
	var m protocol.Message
	t, b, err := p.conn.Read(ctx)
	if err != nil {
		return m, err
	}
	if t != websocket.MessageText {
		return m, errors.New("text frames required")
	}
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&m); err != nil || !json.Valid(b) {
		return m, errors.New("invalid message JSON")
	}
	return m, m.Validate()
}

func HandshakeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 10*time.Second)
}
