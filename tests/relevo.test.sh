#!/usr/bin/env bash
# Tests relevo.sh against stub engines: model table, quota relay, detached runs.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../bin/relevo.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export RELEVO_RUNS="$TMP/runs" RELEVO_MODELS="$HERE/../bin/models.conf" HOME="$TMP/home"
mkdir -p "$TMP/bin" "$TMP/work" "$HOME"
fails=0

check() {
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; fails=$((fails + 1)); fi
}

# Stub engines: each records its args; codex fails on quota when STUB_CODEX_QUOTA=1.
cat > "$TMP/bin/codex" <<'EOF'
#!/usr/bin/env bash
echo "$*" > "$RELEVO_RUNS/.codex-args"
if [ "${STUB_CODEX_QUOTA:-0}" = 1 ]; then echo "ERROR: You have hit your usage limit." >&2; exit 1; fi
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > /dev/null
echo '{"type":"thread.started","thread_id":"t-1"}'
echo '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":10,"reasoning_output_tokens":0}}'
printf 'Status: OK\nFiles: a.txt\n' > "$out"
EOF
cat > "$TMP/bin/agy" <<'EOF'
#!/usr/bin/env bash
echo "$*" > "$RELEVO_RUNS/.agy-args"
if [ "${STUB_AGY_DENIED:-0}" = 1 ]; then
  echo '{"conversation_id":"c-2","status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}'
  exit 0
fi
echo '{"conversation_id":"c-1","status":"SUCCESS","response":"Status: OK","usage":{"input_tokens":100,"output_tokens":5,"thinking_tokens":1,"cache_read_tokens":50}}'
EOF
chmod +x "$TMP/bin/codex" "$TMP/bin/agy"
export RELEVO_CODEX_BIN="$TMP/bin/codex" RELEVO_AGY_BIN="$TMP/bin/agy"

check "plan back/dificil prefers Opus on agy" "$("$SCRIPT" plan -k back -l dificil | head -1)" "agy claude-opus-5-5-high -"
check "plan back/normal prefers Codex" "$("$SCRIPT" plan -k back -l normal | head -1)" "codex gpt-reserve high"
check "plan mech ignores level" "$("$SCRIPT" plan -k mech -l dificil | head -1)" "agy gemini-3.8-flash-low -"
check "plan has a relay row" "$("$SCRIPT" plan -k front -l normal | wc -l | tr -d ' ')" "2"
check "forced engine filters the table" "$("$SCRIPT" plan -k back -l dificil -E codex)" "codex gpt-6-astra high"
check "model override keeps the engine" "$("$SCRIPT" plan -k back -l normal -E agy -m x-model)" "agy x-model -"
"$SCRIPT" plan -k back -l normal -m x-model > /dev/null 2>&1
check "model without engine is refused" "$?" "2"
"$SCRIPT" plan -k nope -l normal > /dev/null 2>&1
check "unknown kind is refused" "$?" "2"

out=$("$SCRIPT" run -n uno -C "$TMP/work" -k back -l normal "do it")
run=$(ls -1d "$RELEVO_RUNS"/*-uno)
check "codex run succeeds" "$(cat "$run/exit")" "0"
check "codex got the table model" "$(grep -o -- '-m gpt-reserve' "$RELEVO_RUNS/.codex-args")" "-m gpt-reserve"
check "codex got the table effort" "$(grep -o 'model_reasoning_effort="high"' "$RELEVO_RUNS/.codex-args")" 'model_reasoning_effort="high"'
check "meta records the model used" "$(grep '^model=' "$run/meta" | tail -1)" "model=gpt-reserve"
check "report is printed" "$(grep -c 'Status: OK' <<< "$out")" "1"

STUB_CODEX_QUOTA=1 "$SCRIPT" run -n dos -C "$TMP/work" -k back -l normal "do it" > /dev/null
run=$(ls -1d "$RELEVO_RUNS"/*-dos)
check "quota hands the task to agy" "$(grep '^engine=' "$run/meta" | tail -1)" "engine=agy"
check "agy got its relay model" "$(grep -o -- '--model claude-sonnet-5-5-medium' "$RELEVO_RUNS/.agy-args")" "--model claude-sonnet-5-5-medium"
check "codex goes on cooldown" "$("$SCRIPT" status | head -1 | cut -d: -f2 | cut -c2-9)" "cooldown"

dir=$("$SCRIPT" start -n tres -C "$TMP/work" -k front -l facil <<< "detached task")
for _ in $(seq 1 50); do [ -f "$dir/exit" ] && break; sleep 0.1; done
check "detached run writes exit" "$(cat "$dir/exit" 2>/dev/null)" "0"
check "detached run used agy flash" "$(grep '^model=' "$dir/meta" | tail -1)" "model=gemini-3.8-flash-medium"
check "prompt holds the task" "$(tail -1 "$dir/prompt.md")" "detached task"

STUB_AGY_DENIED=1 "$SCRIPT" run -n cuatro -C "$TMP/work" -k read -l facil --ro "look" > /dev/null
run=$(ls -1d "$RELEVO_RUNS"/*-cuatro)
check "empty agy answer is a failure" "$(cat "$run/exit")" "1"
check "denied actions reach the report" "$(grep -c 'RunCommand' "$run/last.md")" "1"

[ "$fails" -eq 0 ] && echo "all relevo.sh tests passed" || { echo "$fails failed"; exit 1; }
