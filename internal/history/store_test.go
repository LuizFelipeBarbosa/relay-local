package history

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSummaryAggregatesReportedUsage(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if err := store.Record(Event{Kind: "request", Model: "cliproxyapi/test", Status: "completed", InputTokens: 10, OutputTokens: 4, UsageReported: true, UsageComplete: true}); err != nil {
		t.Fatal(err)
	}
	if err := store.Record(Event{Kind: "request", Model: "cliproxyapi/missing", Status: "completed"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Record(Event{Kind: "request", Model: "cliproxyapi/failed", Status: "failed"}); err != nil {
		t.Fatal(err)
	}

	summary, err := store.Summary(time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if summary.Requests != 3 || summary.Successful != 2 || summary.Failed != 1 {
		t.Fatalf("unexpected counts: %+v", summary)
	}
	if summary.InputTokens != 10 || summary.OutputTokens != 4 || summary.TotalTokens != 14 {
		t.Fatalf("unexpected tokens: %+v", summary)
	}
	if !summary.UsageReported || summary.Complete {
		t.Fatalf("expected reported but incomplete usage: %+v", summary)
	}
}
