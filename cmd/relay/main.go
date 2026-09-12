package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"relay/internal/agent"
	"relay/internal/config"
	"relay/internal/dashboard"
	"relay/internal/installer"
	"relay/protocol"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(os.Args[1:], logger); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "relay:", err)
		os.Exit(1)
	}
}

func run(args []string, logger *slog.Logger) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Println("Usage: relay init|doctor|run|serve|dashboard|install [flags]\n       relay version")
		return nil
	}
	if args[0] == "version" {
		fmt.Println("relay 0.1.0 protocol 1")
		return nil
	}
	f := flag.NewFlagSet(args[0], flag.ContinueOnError)
	path := f.String("config", "relay.json", "configuration file")
	var coordinator, hostID, ollamaModel, proxyModel *string
	if args[0] == "init" {
		coordinator = f.String("coordinator", "ws://127.0.0.1:8080/relay/v1/connect", "coordinator WebSocket URL")
		hostID = f.String("host-id", "host-"+protocol.ID()[:8], "stable host identity")
		ollamaModel = f.String("ollama-model", "", "exact Ollama model name to share")
		proxyModel = f.String("cliproxyapi-model", "", "exact CLIProxyAPI model name to share")
	}
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if args[0] == "init" {
		c := config.Agent{CoordinatorURL: *coordinator, HostID: *hostID, TokenEnv: "RELAY_HOST_TOKEN", StartTimeoutSeconds: 120, TotalTimeoutSeconds: 600, Backends: []config.Backend{
			{ID: "ollama", Kind: "ollama", URL: "http://127.0.0.1:11434", Models: nonempty(*ollamaModel), Concurrency: 1},
			{ID: "cliproxyapi", Kind: "cliproxyapi", URL: "http://127.0.0.1:8317", KeyEnv: "CLIPROXYAPI_KEY", Models: nonempty(*proxyModel), Concurrency: 1},
		}}
		if err := c.Validate(); err != nil {
			return err
		}
		file, err := os.OpenFile(*path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return errors.New("cannot create config (existing files are never overwritten)")
		}
		encoder := json.NewEncoder(file)
		encoder.SetIndent("", "  ")
		err = encoder.Encode(c)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		fmt.Printf("Created %s for host %s. Set RELAY_HOST_TOKEN and CLIPROXYAPI_KEY; only listed models will be shared.\n", *path, c.HostID)
		return nil
	}
	if args[0] == "install" {
		return install(args[1:])
	}
	if args[0] == "dashboard" {
		return openDashboard(args[1:])
	}
	if args[0] != "doctor" && args[0] != "run" && args[0] != "serve" {
		return errors.New("unknown command")
	}
	var c config.Agent
	if err := config.Read(*path, &c); err != nil {
		return err
	}
	a, err := agent.New(c, logger)
	if err != nil {
		return err
	}
	defer a.Close()
	if args[0] == "serve" {
		stateDir := filepath.Join(filepath.Dir(*path), ".relay")
		managed, err := dashboard.New(c, *path, stateDir, logger)
		if err != nil {
			return err
		}
		defer managed.Close()
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		managed.Start(ctx)
		fmt.Printf("Relay dashboard: %s\n", managed.AccessURL("127.0.0.1:7331"))
		return dashboard.ListenAndServe(ctx, managed, "127.0.0.1:7331")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if args[0] == "run" {
		return a.Run(ctx)
	}
	fmt.Printf("Host %s | %s/%s\n", c.HostID, runtime.GOOS, runtime.GOARCH)
	catalog := a.Discover(ctx)
	failed := false
	for _, b := range catalog {
		names := make([]string, 0, len(b.Models))
		for _, m := range b.Models {
			names = append(names, m.ID)
		}
		fmt.Printf("%s: ready=%t slots=%d allowed models=%s\n", b.ID, b.Ready, b.Available, strings.Join(names, ", "))
		if !b.Ready {
			failed = true
		}
	}
	if err := a.Probe(ctx); err != nil {
		fmt.Println("Coordinator: connection/authentication check failed")
		failed = true
	} else {
		fmt.Println("Coordinator: authenticated WebSocket reachable")
	}
	if failed {
		return errors.New("one or more checks failed; check services, allowlists, and credential variables")
	}
	return nil
}

func install(args []string) error {
	f := flag.NewFlagSet("install", flag.ContinueOnError)
	mode := f.String("mode", "headless", "installation mode: gui or headless")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *mode != "gui" && *mode != "headless" {
		return errors.New("mode must be gui or headless")
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	path := filepath.Join(base, "relay", "relay.json")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		c := config.Agent{CoordinatorURL: "ws://127.0.0.1:8080/relay/v1/connect", HostID: "host-" + protocol.ID()[:8], TokenEnv: "RELAY_HOST_TOKEN", StartTimeoutSeconds: 120, TotalTimeoutSeconds: 600, Backends: []config.Backend{
			{ID: "ollama", Kind: "ollama", URL: "http://127.0.0.1:11434", Models: []string{}, Concurrency: 1},
			{ID: "cliproxyapi-8317", Label: "CLIProxyAPI", Kind: "cliproxyapi", URL: "http://127.0.0.1:8317", KeyEnv: "CLIPROXYAPI_KEY", Models: []string{}, Concurrency: 1},
		}}
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		encErr := json.NewEncoder(file).Encode(c)
		closeErr := file.Close()
		if encErr != nil {
			return encErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if executable, err := os.Executable(); err == nil {
		servicePath, serviceErr := installer.ServiceFile("relay", executable, path)
		if serviceErr != nil {
			return serviceErr
		}
		fmt.Printf("Per-user service file: %s\n", servicePath)
		if runtime.GOOS == "darwin" {
			uid := fmt.Sprint(os.Getuid())
			_ = exec.Command("launchctl", "bootstrap", "gui/"+uid, servicePath).Run()
		} else if runtime.GOOS == "linux" {
			_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
			_ = exec.Command("systemctl", "--user", "enable", "--now", "relay-relay.service").Run()
		}
	}
	runtimeDir := filepath.Join(filepath.Dir(path), "runtimes")
	for _, name := range []string{"ollama", "cliproxyapi"} {
		executable := installer.Detect(name)
		if executable != "" {
			fmt.Printf("Detected %s at %s\n", name, executable)
		} else {
			fmt.Printf("Installing %s runtime from its pinned release...\n", name)
			if found, installErr := installer.InstallRuntime(name, runtimeDir); installErr != nil {
				return fmt.Errorf("install %s: %w", name, installErr)
			} else {
				executable = found
				fmt.Printf("Installed %s at %s\n", name, executable)
			}
		}
		if servicePath, serviceErr := installer.ServiceFile(name, executable, ""); serviceErr == nil {
			fmt.Printf("Runtime service file: %s\n", servicePath)
			if runtime.GOOS == "darwin" {
				_ = exec.Command("launchctl", "bootstrap", "gui/"+fmt.Sprint(os.Getuid()), servicePath).Run()
			}
			if runtime.GOOS == "linux" {
				_ = exec.Command("systemctl", "--user", "enable", "--now", "relay-"+name+".service").Run()
			}
		}
	}
	if *mode == "gui" {
		return openDashboard([]string{"--config", path})
	}
	fmt.Printf("Relay installed for this user. Configuration: %s\nRun: relay serve --config %s\n", path, path)
	return nil
}

func openDashboard(args []string) error {
	f := flag.NewFlagSet("dashboard", flag.ContinueOnError)
	path := f.String("config", filepath.Join(mustUserConfigDir(), "relay", "relay.json"), "configuration file")
	if err := f.Parse(args); err != nil {
		return err
	}
	tokenPath := filepath.Join(filepath.Dir(*path), ".relay", "dashboard.token")
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		return errors.New("dashboard is not running; start `relay serve` first")
	}
	url := "http://127.0.0.1:7331/?token=" + strings.TrimSpace(string(token))
	fmt.Println(url)
	if runtime.GOOS == "darwin" {
		_ = exec.Command("open", url).Run()
	} else if runtime.GOOS == "linux" {
		_ = exec.Command("xdg-open", url).Run()
	}
	return nil
}

func mustUserConfigDir() string {
	p, err := os.UserConfigDir()
	if err != nil {
		return "."
	}
	return p
}

func nonempty(value string) []string {
	if value == "" {
		return []string{}
	}
	return []string{value}
}
