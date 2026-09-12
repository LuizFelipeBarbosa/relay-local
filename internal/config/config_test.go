package config

import "testing"

func TestTransportAndCredentialConfiguration(t *testing.T) {
	base := Agent{CoordinatorURL: "ws://127.0.0.1:8080/relay/v1/connect", HostID: "host", TokenEnv: "HOST_KEY", Backends: []Backend{{ID: "local", Kind: "ollama", URL: "http://127.0.0.1:11434", Models: []string{"echo"}}}}
	for _, url := range []string{"ws://example.com/relay/v1/connect", "wss://key@example.com/relay/v1/connect", "wss://example.com/relay/v1/connect?key=secret"} {
		c := base
		c.CoordinatorURL = url
		if c.Validate() == nil {
			t.Errorf("accepted %s", url)
		}
	}
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}
	if base.Backends[0].Concurrency != 1 || base.StartTimeoutSeconds != 120 || base.TotalTimeoutSeconds != 600 {
		t.Fatal("incorrect defaults")
	}
	c := Coordinator{Listen: "0.0.0.0:8080", BuyerTokenEnv: "BUYER", Hosts: map[string]string{"host": "HOST_KEY"}}
	if c.Validate() == nil {
		t.Fatal("public plaintext listener accepted")
	}
}
