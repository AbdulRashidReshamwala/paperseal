package release

import "encoding/json"

func marshalLog(l Log) ([]byte, error) { return json.Marshal(l) }
