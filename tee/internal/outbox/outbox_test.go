package outbox

import (
	"context"
	"errors"
	"testing"
)

func TestQueue(t *testing.T) {
	var q Memory
	ctx := context.Background()
	if got, _ := q.List(ctx); len(got) != 0 {
		t.Fatal("not empty")
	}
	m := Message{Kind: KindBuild, Selected: 3, InstancePublicKey: []byte{4}}
	if err := q.Put(ctx, m); err != nil {
		t.Fatal(err)
	}
	if err := q.Put(ctx, m); !errors.Is(err, ErrAlreadyQueued) {
		t.Fatalf("second Build: %v", err)
	}
	got, _ := q.List(ctx)
	if len(got) != 1 || got[0].Selected != 3 {
		t.Fatalf("list: %+v", got)
	}
}
