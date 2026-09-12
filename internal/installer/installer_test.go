package installer

import "testing"

func TestVerifyRejectsUnpinnedOrChangedArtifact(t *testing.T) {
	if Verify([]byte("artifact"), "") == nil {
		t.Fatal("accepted an unpinned artifact")
	}
	if Verify([]byte("artifact"), "deadbeef") == nil {
		t.Fatal("accepted a checksum mismatch")
	}
}

func TestVerifyAcceptsSHA256(t *testing.T) {
	if err := Verify([]byte("artifact"), "c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c"); err != nil {
		t.Fatal(err)
	}
}
