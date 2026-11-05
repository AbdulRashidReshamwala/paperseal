package lifecycle_test

import "time"

func timeAgo() time.Time   { return time.Now().Add(-48 * time.Hour) }
func timeAhead() time.Time { return time.Now().Add(48 * time.Hour) }
