#!/usr/bin/env bash
# Submit one group (one request, 1-50 JPEGs) to the async embeddings API.
# Usage: INFERENCE_API_KEY=... INFERENCE_WEBHOOK_ID=... INFERENCE_MODEL=... ./curl.sh a.jpg b.jpg ...
# inference.net gives you the model id for your account.
# Each image's custom id is its file name, so use names without quotes or backslashes.
set -euo pipefail
: "${INFERENCE_API_KEY:?set INFERENCE_API_KEY}" "${INFERENCE_WEBHOOK_ID:?set INFERENCE_WEBHOOK_ID}" "${INFERENCE_MODEL:?set INFERENCE_MODEL}"
[ $# -ge 1 ] && [ $# -le 50 ] || { echo "usage: $0 <1-50 jpeg files>" >&2; exit 2; }

body() {
  printf '{"webhook_id":"%s","requests":[{"model":"%s","encoding_format":"base64","input":[' "$INFERENCE_WEBHOOK_ID" "$INFERENCE_MODEL"
  sep=""
  for f in "$@"; do
    printf '%s[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,' "$sep"
    base64 < "$f" | tr -d '\n'
    printf '"}}]}]'
    sep=","
  done
  printf '],"metadata":{"custom_ids":['
  sep=""
  for f in "$@"; do printf '%s"%s"' "$sep" "$(basename "$f")"; sep=","; done
  printf ']}}]}'
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
body "$@" > "$tmp"

# Prints {"groupId":"...","groupSize":1}. The webhook arrives when the group is done.
# The same files sent again within 1 hour return the same group: the key is a hash of the body.
curl -sS --fail-with-body https://api.inference.net/v1/async/group/embeddings \
  -H "Authorization: Bearer $INFERENCE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(shasum -a 256 < "$tmp" | cut -d' ' -f1)" \
  -H "User-Agent: embeddings-submit/1.0" \
  --data-binary @"$tmp"
echo
