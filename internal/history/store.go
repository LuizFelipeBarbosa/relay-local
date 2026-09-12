package history

import (
	"encoding/json"
	"time"

	"go.etcd.io/bbolt"
)

var bucket = []byte("events")

type Event struct {
	Time         time.Time `json:"time"`
	Kind         string    `json:"kind"`
	Model        string    `json:"model,omitempty"`
	Status       string    `json:"status,omitempty"`
	DurationMS   int64     `json:"duration_ms,omitempty"`
	InputTokens  int64     `json:"input_tokens,omitempty"`
	OutputTokens int64     `json:"output_tokens,omitempty"`
}

type Store struct{ db *bbolt.DB }

func Open(path string) (*Store, error) {
	db, err := bbolt.Open(path, 0600, &bbolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	if err = db.Update(func(tx *bbolt.Tx) error { _, e := tx.CreateBucketIfNotExists(bucket); return e }); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}
func (s *Store) Record(event Event) error {
	if event.Time.IsZero() {
		event.Time = time.Now().UTC()
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket(bucket)
		key := []byte(event.Time.Format(time.RFC3339Nano) + "/" + event.Kind)
		return b.Put(key, data)
	})
}
func (s *Store) Recent(limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 100
	}
	result := []Event{}
	err := s.db.View(func(tx *bbolt.Tx) error {
		c := tx.Bucket(bucket).Cursor()
		for k, v := c.Last(); k != nil && len(result) < limit; k, v = c.Prev() {
			var e Event
			if json.Unmarshal(v, &e) == nil {
				result = append(result, e)
			}
		}
		return nil
	})
	return result, err
}
