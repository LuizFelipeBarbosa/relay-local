package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"relay/internal/config"
	"relay/internal/coordinator"
)

func main() {
	path := flag.String("config", "coordinator.json", "configuration file")
	flag.Parse()
	if err := run(*path); err != nil {
		fmt.Fprintln(os.Stderr, "relay-coordinator:", err)
		os.Exit(1)
	}
}

func run(path string) error {
	var c config.Coordinator
	if err := config.Read(path, &c); err != nil {
		return err
	}
	if err := c.Validate(); err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	s, err := coordinator.New(c, logger)
	if err != nil {
		return err
	}
	defer s.Close()
	server := &http.Server{Addr: c.Listen, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		s.Close()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = server.Shutdown(shutdown)
	}()
	logger.Info("reference coordinator listening", "address", c.Listen)
	if c.TLSCert != "" {
		err = server.ListenAndServeTLS(c.TLSCert, c.TLSKey)
	} else {
		err = server.ListenAndServe()
	}
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
