#!/usr/bin/env bash
# Live walker progress check.
#
# Restarts the border walk and fails if the bot covers less than 2 blocks in
# 15 seconds. This is the feedback loop used to diagnose "the dashboard is
# stuck at 57,191 / 57,192": it drives the real walker against the real
# server, so it catches movement, pathing and server-setback regressions.
#
#   ID=<instance-id> API=http://127.0.0.1:8790 ./scripts/walker-progress.sh
#
# Exit 0 = the bot made net progress; exit 1 = it is pinned.
set -euo pipefail

ID=${ID:?set ID to the daemon instance id}
API=${API:-http://127.0.0.1:8790}

send() {
  curl -s -m 5 -X POST "$API/api/v1/instances/$ID/input" \
    -H 'Content-Type: application/json' -d "{\"line\":\"$1\"}" -o /dev/null
}
pos() {
  curl -s -m 5 "$API/progress" | python3 -c \
    "import json,sys; p=json.load(sys.stdin); print(p['position']['x'], p['position']['z'], p['distance'])"
}

send '.border-stop'
sleep 1
send '.border-walk ne'
sleep 2
read -r x0 z0 d0 < <(pos)
echo "start  x=$x0 z=$z0 dist=$d0"
for i in $(seq 1 15); do
  sleep 1
  read -r x z d < <(pos)
  printf 't%-2s x=%-8s z=%-8s dist=%s\n' "$i" "$x" "$z" "$d"
done
read -r x1 z1 _ < <(pos)
python3 - "$x0" "$z0" "$x1" "$z1" <<'PY'
import math, sys
x0, z0, x1, z1 = map(float, sys.argv[1:])
moved = math.hypot(x1 - x0, z1 - z0)
print(f"net displacement {moved:.2f} blocks")
sys.exit(0 if moved >= 2 else 1)
PY
