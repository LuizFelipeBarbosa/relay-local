package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
)

type Backend struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	URL         string   `json:"url"`
	KeyEnv      string   `json:"key_env,omitempty"`
	Models      []string `json:"models"`
	Concurrency int      `json:"concurrency"`
	Label       string   `json:"label,omitempty"`
}

type Price struct {
	InputPerMillion  string `json:"input_per_million,omitempty"`
	OutputPerMillion string `json:"output_per_million,omitempty"`
}

type Availability struct {
	Enabled  bool   `json:"enabled"`
	Paused   bool   `json:"paused"`
	Timezone string `json:"timezone,omitempty"`
}

type Agent struct {
	CoordinatorURL      string           `json:"coordinator_url"`
	HostID              string           `json:"host_id"`
	TokenEnv            string           `json:"token_env"`
	StartTimeoutSeconds int              `json:"start_timeout_seconds"`
	TotalTimeoutSeconds int              `json:"total_timeout_seconds"`
	Backends            []Backend        `json:"backends"`
	Prices              map[string]Price `json:"prices,omitempty"`
	Availability        Availability     `json:"availability,omitempty"`
}

type Coordinator struct {
	Listen              string            `json:"listen"`
	TLSCert             string            `json:"tls_cert,omitempty"`
	TLSKey              string            `json:"tls_key,omitempty"`
	BuyerTokenEnv       string            `json:"buyer_token_env"`
	Hosts               map[string]string `json:"hosts"`
	StartTimeoutSeconds int               `json:"start_timeout_seconds"`
	TotalTimeoutSeconds int               `json:"total_timeout_seconds"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func Read(path string, target any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 1<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return errors.New("invalid configuration JSON")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing configuration")
	}
	return nil
}

func (c *Agent) Validate() error {
	if !identifier.MatchString(c.HostID) || !identifier.MatchString(c.TokenEnv) {
		return errors.New("host_id and token_env must be identifiers")
	}
	u, err := url.Parse(c.CoordinatorURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/relay/v1/connect" {
		return errors.New("invalid coordinator URL; expected /relay/v1/connect without credentials or query")
	}
	if u.Scheme != "wss" && !(u.Scheme == "ws" && LoopbackName(u.Hostname())) {
		return errors.New("coordinator requires wss outside loopback")
	}
	if err := timeouts(&c.StartTimeoutSeconds, &c.TotalTimeoutSeconds); err != nil {
		return err
	}
	if len(c.Backends) == 0 || len(c.Backends) > 64 {
		return errors.New("configure 1–64 backends")
	}
	ids := map[string]bool{}
	total := 0
	for i := range c.Backends {
		b := &c.Backends[i]
		if !identifier.MatchString(b.ID) || ids[b.ID] {
			return errors.New("backend IDs must be unique identifiers")
		}
		ids[b.ID] = true
		if b.Kind != "ollama" && b.Kind != "cliproxyapi" {
			return errors.New("unsupported backend kind")
		}
		if b.KeyEnv != "" && !identifier.MatchString(b.KeyEnv) {
			return errors.New("invalid backend key_env")
		}
		u, err := url.Parse(b.URL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") {
			return fmt.Errorf("backend %s requires a root HTTP URL without credentials", b.ID)
		}
		b.URL = strings.TrimRight(b.URL, "/")
		if b.Concurrency == 0 {
			b.Concurrency = 1
		}
		if b.Concurrency < 1 || b.Concurrency > 64 {
			return errors.New("backend concurrency must be 1–64")
		}
		total += b.Concurrency
		if len(b.Models) > 1024 {
			return errors.New("too many allowed models")
		}
		seen := map[string]bool{}
		for _, m := range b.Models {
			if m == "" || len(m) > 256 || strings.ContainsAny(m, "\r\n") || seen[m] {
				return errors.New("model allowlists require unique nonempty names")
			}
			seen[m] = true
		}
	}
	if total > 64 {
		return errors.New("total concurrency must not exceed 64")
	}
	return nil
}

func (c *Coordinator) Validate() error {
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8080"
	}
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return errors.New("invalid listen address")
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return errors.New("both TLS certificate and key are required")
	}
	if c.TLSCert == "" && !LoopbackName(host) {
		return errors.New("non-loopback listener requires TLS")
	}
	if !identifier.MatchString(c.BuyerTokenEnv) || len(c.Hosts) == 0 {
		return errors.New("buyer token and host allowlist required")
	}
	for id, env := range c.Hosts {
		if !identifier.MatchString(id) || !identifier.MatchString(env) {
			return errors.New("invalid host credential mapping")
		}
	}
	return timeouts(&c.StartTimeoutSeconds, &c.TotalTimeoutSeconds)
}

func timeouts(start, total *int) error {
	if *start == 0 {
		*start = 120
	}
	if *total == 0 {
		*total = 600
	}
	if *start < 1 || *total < *start || *total > 86400 {
		return errors.New("timeouts must satisfy 1 <= start <= total <= 86400 seconds")
	}
	return nil
}

func LoopbackName(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func Secret(env string) (string, error) {
	value := os.Getenv(env)
	if value == "" || strings.ContainsAny(value, "\r\n") {
		return "", fmt.Errorf("set credential environment variable %s", env)
	}
	return value, nil
}
