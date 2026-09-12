// Package installer handles per-user runtime installation metadata and service files.
package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type Artifact struct {
	Name    string `json:"name"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}

// Manifest is intentionally checked into the release build. An empty URL is a
// visible "not bundled for this platform" state rather than an unverified download.
var Manifest = []Artifact{
	{Name: "ollama", OS: "darwin", Arch: "arm64", Version: "0.34.0", URL: "https://github.com/ollama/ollama/releases/download/v0.34.0/Ollama-darwin.zip", SHA256: "5bb6b982f74184d4b67c1829fa76851ac849a2714bf3de506be41bb1860d3ce3"},
	{Name: "ollama", OS: "darwin", Arch: "amd64", Version: "0.34.0", URL: "https://github.com/ollama/ollama/releases/download/v0.34.0/Ollama-darwin.zip", SHA256: "5bb6b982f74184d4b67c1829fa76851ac849a2714bf3de506be41bb1860d3ce3"},
	{Name: "ollama", OS: "linux", Arch: "arm64", Version: "0.34.0", URL: "https://github.com/ollama/ollama/releases/download/v0.34.0/ollama-linux-arm64.tar.zst", SHA256: "6a9e5b3650c2024d8a78da86b23876f6eea238657a3262d7e5ec0f3688c5d28e"},
	{Name: "ollama", OS: "linux", Arch: "amd64", Version: "0.34.0", URL: "https://github.com/ollama/ollama/releases/download/v0.34.0/ollama-linux-amd64.tar.zst", SHA256: "cf95886728959aa09910bb34de5cca1cc5a8f68003b5597197d3f2c2d57c0804"},
	{Name: "cliproxyapi", OS: "darwin", Arch: "arm64", Version: "7.2.159", URL: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.159/CLIProxyAPI_7.2.159_darwin_aarch64.tar.gz", SHA256: "ff6df9e2181bdc13deb011e935eecfeea10b03fde1cb896aa5db1f2a172d625d"},
	{Name: "cliproxyapi", OS: "darwin", Arch: "amd64", Version: "7.2.159", URL: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.159/CLIProxyAPI_7.2.159_darwin_amd64.tar.gz", SHA256: "7dd08aba651f6b4fa3a1ec2e3af7e6b47df0aa46b1f9c400b759588a8911fcee"},
	{Name: "cliproxyapi", OS: "linux", Arch: "arm64", Version: "7.2.159", URL: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.159/CLIProxyAPI_7.2.159_linux_aarch64_no-plugin.tar.gz", SHA256: "874f5ac3131055e8074331724e95f918753a76ca15c93629d11eea87da4c575c"},
	{Name: "cliproxyapi", OS: "linux", Arch: "amd64", Version: "7.2.159", URL: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.159/CLIProxyAPI_7.2.159_linux_amd64_no-plugin.tar.gz", SHA256: "b01d01d8f3275e9fa842fda3636f3634dcb915179b1ece8d094f7d8a992884d2"},
}

func Current(name string) (Artifact, error) {
	for _, a := range Manifest {
		if a.Name == name && a.OS == runtime.GOOS && a.Arch == runtime.GOARCH {
			return a, nil
		}
	}
	return Artifact{}, fmt.Errorf("%s is not supported on %s/%s", name, runtime.GOOS, runtime.GOARCH)
}

func Verify(data []byte, expected string) error {
	if expected == "" {
		return errors.New("runtime artifact has no pinned checksum")
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != expected {
		return errors.New("runtime artifact checksum mismatch")
	}
	return nil
}

func InstallArtifact(a Artifact, destination string) error {
	if a.URL == "" {
		return fmt.Errorf("no pinned release artifact for %s/%s", a.Name, a.OS+"/"+a.Arch)
	}
	resp, err := http.Get(a.URL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime download returned status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 512<<20))
	if err != nil {
		return err
	}
	if err := Verify(data, a.SHA256); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	tmp := destination + ".download"
	if err := os.WriteFile(tmp, data, 0700); err != nil {
		return err
	}
	return os.Rename(tmp, destination)
}

// InstallRuntime downloads, verifies, extracts, and installs the executable
// from the pinned artifact into a private runtime directory.
func InstallRuntime(name, directory string) (string, error) {
	a, err := Current(name)
	if err != nil {
		return "", err
	}
	resp, err := http.Get(a.URL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("runtime download returned status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<30))
	if err != nil {
		return "", err
	}
	if err := Verify(data, a.SHA256); err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	ext := filepath.Join(directory, a.Name+"-"+a.Version+archiveExtension(a.URL))
	if err := os.WriteFile(ext, data, 0600); err != nil {
		return "", err
	}
	defer os.Remove(ext)
	if strings.HasSuffix(a.URL, ".zip") {
		err = exec.Command("unzip", "-oq", ext, "-d", directory).Run()
	} else if strings.HasSuffix(a.URL, ".tar.gz") {
		err = exec.Command("tar", "-xzf", ext, "-C", directory).Run()
	} else {
		err = exec.Command("tar", "--zstd", "-xf", ext, "-C", directory).Run()
	}
	if err != nil {
		return "", fmt.Errorf("extract runtime: %w", err)
	}
	var found string
	_ = filepath.Walk(directory, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr == nil && info != nil && !info.IsDir() && (info.Name() == a.Name || info.Name() == "cli-proxy-api") {
			found = path
		}
		return nil
	})
	if found == "" {
		return "", errors.New("runtime archive did not contain its executable")
	}
	destination := filepath.Join(directory, a.Name)
	if found != destination {
		if err := os.Rename(found, destination); err != nil {
			return "", err
		}
	}
	if err := os.Chmod(destination, 0700); err != nil {
		return "", err
	}
	return destination, nil
}

func archiveExtension(url string) string {
	for _, suffix := range []string{".tar.zst", ".tar.gz", ".zip"} {
		if strings.HasSuffix(url, suffix) {
			return suffix
		}
	}
	return ".download"
}

func Detect(name string) string {
	path, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	return path
}

func ServiceDirectory() (string, error) {
	base, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(base, ".config", "systemd", "user")
	if runtime.GOOS == "darwin" {
		path = filepath.Join(base, "Library", "LaunchAgents")
	}
	if err := os.MkdirAll(path, 0700); err != nil {
		return "", err
	}
	return path, nil
}

func ServiceFile(name, executable, config string) (string, error) {
	dir, err := ServiceDirectory()
	if err != nil {
		return "", err
	}
	args := []string{executable}
	if name == "relay" {
		args = append(args, "serve", "--config", config)
	} else if name == "ollama" {
		args = append(args, "serve")
	}
	plistArgs := ""
	for _, arg := range args {
		plistArgs += "<string>" + arg + "</string>"
	}
	if runtime.GOOS == "darwin" {
		body := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>com.relay.%s</string><key>ProgramArguments</key><array>%s</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n", name, plistArgs)
		path := filepath.Join(dir, "com.relay."+name+".plist")
		return path, os.WriteFile(path, []byte(body), 0600)
	}
	body := fmt.Sprintf("[Unit]\nDescription=Relay %s\nAfter=network-online.target\n\n[Service]\nExecStart=%s\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n", name, strings.Join(args, " "))
	path := filepath.Join(dir, "relay-"+name+".service")
	return path, os.WriteFile(path, []byte(body), 0600)
}
