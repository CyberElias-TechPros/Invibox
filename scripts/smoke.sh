#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE_URL:-http://localhost:5173/api/v1}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
json(){ node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync('$1','utf8'));const value=$2;process.stdout.write(String(value))"; }

curl -fsS -c "$TMP/cookies" -X POST -H 'Content-Type: application/json' \
  --data "{\"name\":\"Smoke Test Host\",\"email\":\"$EMAIL\",\"password\":\"StrongPass-2026\"}" "$BASE/auth/register" > "$TMP/user.json"
curl -fsS -b "$TMP/cookies" -X POST -H 'Content-Type: application/json' \
  --data '{"title":"Smoke Celebration","eventType":"wedding","date":"2027-02-14","location":"Lagos, Nigeria","timezone":"Africa/Lagos"}' "$BASE/events" > "$TMP/event.json"
EVENT_ID=$(json "$TMP/event.json" 'x.event.id'); SLUG=$(json "$TMP/event.json" 'x.event.slug')

curl -fsS -b "$TMP/cookies" -X PUT -H 'Content-Type: application/json' \
  --data '{"schedule":[{"time":"14:00","title":"Main celebration","place":"Lagos","audience":"All guests"}]}' "$BASE/events/$EVENT_ID/schedule/sync" >/dev/null
curl -fsS -b "$TMP/cookies" -X PATCH -H 'Content-Type: application/json' \
  --data '{"lifecycle":"published"}' "$BASE/events/$EVENT_ID" >/dev/null
curl -fsS -b "$TMP/cookies" -X POST -H 'Content-Type: application/json' \
  --data '{"name":"Kemi Smoke","group":"Friends","status":"Pending","party":2,"meal":"—"}' "$BASE/events/$EVENT_ID/guests" > "$TMP/guest.json"
GUEST_ID=$(json "$TMP/guest.json" 'x.guest.id'); TOKEN=$(json "$TMP/guest.json" 'x.token')

curl -fsS "$BASE/public/events/$SLUG?token=$TOKEN" > "$TMP/public.json"
OCCASION_ID=$(json "$TMP/public.json" 'x.occasions[0].id')
curl -fsS -X POST -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-rsvp-1' \
  --data "{\"token\":\"$TOKEN\",\"responses\":[{\"occasionId\":\"$OCCASION_ID\",\"status\":\"attending\"}]}" "$BASE/public/rsvp" >/dev/null
# Prove retries are safe.
curl -fsS -X POST -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-rsvp-1' \
  --data "{\"token\":\"$TOKEN\",\"responses\":[{\"occasionId\":\"$OCCASION_ID\",\"status\":\"attending\"}]}" "$BASE/public/rsvp" > "$TMP/replay.json"

curl -fsS -b "$TMP/cookies" -X POST -H 'Content-Type: application/json' \
  --data '{"name":"S01","shape":"round","capacity":8,"x":40,"y":40}' "$BASE/events/$EVENT_ID/seating" >/dev/null
curl -fsS -b "$TMP/cookies" -X PATCH -H 'Content-Type: application/json' \
  --data '{"table":"S01"}' "$BASE/events/$EVENT_ID/guests/$GUEST_ID/seat" >/dev/null
curl -fsS -b "$TMP/cookies" -X POST -H 'Content-Type: application/json' \
  --data "{\"token\":\"$TOKEN\"}" "$BASE/events/$EVENT_ID/checkin/scan" >/dev/null
curl -fsS -b "$TMP/cookies" -X POST -F 'file=@public/gallery-table.jpg;type=image/jpeg' -F 'caption=Smoke test memory' \
  "$BASE/events/$EVENT_ID/media" > "$TMP/media.json"
MEDIA_ID=$(json "$TMP/media.json" 'x.id')
curl -fsS -b "$TMP/cookies" -X PATCH -H 'Content-Type: application/json' --data '{"status":"approved"}' \
  "$BASE/events/$EVENT_ID/media/$MEDIA_ID" >/dev/null
curl -fsS -b "$TMP/cookies" "$BASE/events/$EVENT_ID/media/$MEDIA_ID/file" -o "$TMP/media.jpg"
test -s "$TMP/media.jpg"

curl -fsS -b "$TMP/cookies" "$BASE/events/$EVENT_ID/snapshot" > "$TMP/snapshot.json"
node - "$TMP/snapshot.json" "$TMP/replay.json" <<'NODE'
const fs=require('fs');
const snapshot=JSON.parse(fs.readFileSync(process.argv[2]));
const replay=JSON.parse(fs.readFileSync(process.argv[3]));
if(snapshot.guests.length!==1 || !snapshot.guests[0].checkedIn || snapshot.guests[0].table!=='S01') throw new Error('guest lifecycle failed');
if(snapshot.media.length!==1 || snapshot.media[0].status!=='approved') throw new Error('media lifecycle failed');
if(!replay.replayed) throw new Error('RSVP replay was not idempotent');
console.log('Smoke test passed: auth → event → schedule → publish → invite → RSVP → seat → check-in → media → moderation');
NODE
