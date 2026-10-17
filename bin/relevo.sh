#!/usr/bin/env bash
# Runs a coding task on an external agent (Codex CLI or Antigravity agy) so the
# work spends that agent's quota instead of Claude's. The model comes from
# models.conf by kind and level; when an engine runs out of quota it goes on
# cooldown and the next row of the table takes the same task.
#
# Usage:
#   relevo.sh start -n <name> -C <dir> -k back|front|read|mech -l facil|normal|dificil
#                   [-E codex|agy] [-m <model>] [-e <effort>] [-w <write-lot>]
#                   [-r <read-only>] [--ro|--full] [--net] [--add-dir <dir>]... [prompt]
#                   Starts detached and prints the run dir (prompt from args or stdin).
#   relevo.sh run   ...same options...       Same, in the foreground.
#   relevo.sh resume <name|run-dir> [message]   Detached follow-up on the same conversation.
#   relevo.sh plan -k <kind> -l <level> [-E <engine>]   Engines and models that would run.
#   relevo.sh list [n] | status | runs
#
# Each run lives in $RELEVO_RUNS/<ts>-<name>/: prompt.md, meta, events.jsonl,
# last.md (final report), stderr.log, and exit once it has finished.
set -uo pipefail

RUNS="${RELEVO_RUNS:-$HOME/.claude/relevo-runs}"
TIMEOUT="${RELEVO_TIMEOUT:-3600}"
COOLDOWN="${RELEVO_COOLDOWN:-3600}"
CODEX_BIN="${RELEVO_CODEX_BIN:-codex}"
AGY_BIN="${RELEVO_AGY_BIN:-agy}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${RELEVO_MODELS:-}"
[ -z "$CONF" ] && { [ -f "$HOME/.config/ia-relevo/models.conf" ] && CONF="$HOME/.config/ia-relevo/models.conf" || CONF="$HERE/models.conf"; }
QUOTA_RE='usage limit|rate.?limit|quota|resource.?exhausted|insufficient_quota|exceeded your|HTTP 429|status 429|credits|not logged in|unauthori[sz]ed|login required'
mkdir -p "$RUNS"

die() { echo "relevo: $*" >&2; exit 2; }

rules() {
  cat <<EOF
You are a subagent launched by the main Claude session. Working directory: $1
Reply and report in the same language the task is written in. Code identifiers
and comments follow the language of the surrounding code.

RULES
- Closed task: do exactly what is asked. Anything out of scope goes under
  "Pending", it is not fixed.
- Match the style of the file you touch: same comment density, same naming.
- Read a file whole before editing it. Locate code before assuming.
- Prefer your own file read, search and edit tools over shell commands; shell
  commands may be denied in this run.
- Single verification at the end: one run of the whole process.
- Do NOT git commit, push, merge, rebase or switch branches. The main session commits.
- Do not read or print secrets (.env, *.pem, *.key, tokens).
- If something you need is missing, stop and report it as BLOCKED.
EOF
  [ -n "$2" ] && printf '\nWRITE LOT (the only place you may write):\n  %s\n' "$2"
  [ -n "$3" ] && printf 'READ ONLY:\n  %s\n' "$3"
  [ -n "$2" ] && printf 'If you need to write outside your lot, do NOT: report it as BLOCKED.\n'
  cat <<'EOF'

FINAL REPORT (your last message, at most 15 lines, no code repeated):
Status: OK | FAILED | BLOCKED
Files: paths modified or created
Verification: command run and result
Errors: exact message, cause and file (if any)
Pending: what is left or seen out of scope

TASK
EOF
}

meta() { sed -n "s/^$2=//p" "$1/meta" | tail -1; }

resolve_run() {
  local q="$1"
  [ -d "$q" ] && { echo "$q"; return; }
  ls -1d "$RUNS"/*-"$q" 2>/dev/null | tail -1
}

on_cooldown() {
  local f="$RUNS/.cooldown-$1"
  [ -f "$f" ] && [ "$(cat "$f")" -gt "$(date +%s)" ]
}

with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null; then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null; then gtimeout "$secs" "$@"
  else "$@"
  fi
}

# Prints "engine model effort" per matching row of the table, in order.
plan_rows() {
  local kind="$1" level="$2" engine="$3"
  [ -f "$CONF" ] || die "no encuentro la tabla de modelos: $CONF"
  awk -v k="$kind" -v l="$level" -v e="$engine" '
    /^[[:space:]]*(#|$)/ { next }
    $1 == k && ($2 == l || $2 == "*") && (e == "" || $3 == e) { print $3, $4, $5 }
  ' "$CONF"
}

quota_hit() {
  local run="$1" rc="$2"
  [ "$rc" -eq 0 ] && [ -s "$run/last.md" ] && return 1
  local errs
  errs=$(tail -n 30 "$run/stderr.log" 2>/dev/null; grep -E '"type":"(error|turn\.failed)"|"status":"(ERROR|FAILED)' "$run/events.jsonl" 2>/dev/null | tail -n 5)
  grep -qiE "$QUOTA_RE" <<< "$errs"
}

# Runs one attempt. Args: run engine model effort mode(new|resume) input-file
attempt() {
  local run="$1" engine="$2" model="$3" effort="$4" how="$5" input="$6"
  local dir sandbox net sid
  dir=$(meta "$run" dir); sandbox=$(meta "$run" sandbox); net=$(meta "$run" net)
  sid=$(meta "$run" session)
  [ "$model" = - ] && model=""
  [ "$effort" = - ] && effort=""
  local -a extra=(); read -ra extra <<< "$(meta "$run" adddirs)"
  rm -f "$run/last.md"

  if [ "$engine" = codex ]; then
    local -a args=(exec)
    [ "$how" = resume ] && args+=(resume)
    args+=(--json -o "$run/last.md" --skip-git-repo-check)
    if [ "$how" = resume ]; then
      args+=(-c "sandbox_mode=\"$sandbox\"")
    else
      args+=(-C "$dir" -s "$sandbox")
      for d in "${extra[@]}"; do args+=(--add-dir "$d"); done
    fi
    [ "$net" = 1 ] && args+=(-c sandbox_workspace_write.network_access=true)
    [ -n "$model" ] && args+=(-m "$model")
    [ -n "$effort" ] && args+=(-c "model_reasoning_effort=\"$effort\"")
    [ "$how" = resume ] && args+=("$sid")
    args+=(-)
    (cd "$dir" && with_timeout "$TIMEOUT" "$CODEX_BIN" "${args[@]}" < "$input" >> "$run/events.jsonl" 2>> "$run/stderr.log")
    return $?
  fi

  # agy only runs shell commands allowed in its own settings; denied ones are
  # listed in the report.
  local -a args=(-p "$(cat "$input")" --output-format json --print-timeout "${TIMEOUT}s")
  [ -n "$model" ] && args+=(--model "$model")
  [ -n "$effort" ] && args+=(--effort "$effort")
  case "$sandbox" in
    read-only) args+=(--sandbox --mode plan) ;;
    workspace-write) args+=(--sandbox --mode accept-edits) ;;
    *) args+=(--mode accept-edits) ;;
  esac
  for d in "${extra[@]}"; do args+=(--add-dir "$d"); done
  [ "$how" = resume ] && args+=(--conversation "$sid")
  local out rc
  out="$run/agy-$(date +%s).json"
  (cd "$dir" && with_timeout "$((TIMEOUT + 60))" "$AGY_BIN" "${args[@]}" > "$out" 2>> "$run/stderr.log")
  rc=$?
  cat "$out" >> "$run/events.jsonl"; echo >> "$run/events.jsonl"
  python3 -I - "$out" "$run/last.md" <<'EOF' || { [ "$rc" -eq 0 ] && rc=1; }
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
text = d.get("response", "").strip()
denied = d.get("denied_actions") or []
if denied:
    text += "\nDenied actions (missing agy allow rule): " + ", ".join(
        a.get("display_name", a.get("action", "?")) for a in denied)
if text:
    open(sys.argv[2], "w").write(text + "\n")
# A headless agy that hit a denied tool can end "SUCCESS" with no answer at all.
sys.exit(0 if d.get("status") == "SUCCESS" and d.get("response", "").strip() else 1)
EOF
  return "$rc"
}

session_of() {
  local key='conversation_id'
  [ "$2" = codex ] && key='(thread_id|session_id|conversation_id)'
  grep -oE "\"$key\": ?\"[^\"]+\"" "$1/events.jsonl" 2>/dev/null | tail -1 | sed -E 's/.*"([^"]+)"$/\1/'
}

finish() {
  local run="$1" rc="$2" engine="$3" sid
  sid=$(session_of "$run" "$engine")
  [ -n "$sid" ] && [ "$sid" != "$(meta "$run" session)" ] && echo "session=$sid" >> "$run/meta"
  echo "$rc" > "$run/exit.tmp" && mv -f "$run/exit.tmp" "$run/exit"
  echo "relevo: $(meta "$run" name) engine=$engine model=$(meta "$run" model) exit=$rc run=$run"
  if [ -s "$run/last.md" ]; then
    head -n 80 "$run/last.md"
  else
    echo "(no final report) last lines of stderr:"
    tail -n 15 "$run/stderr.log" 2>/dev/null
  fi
  exit "$rc"
}

# Runs a prepared run dir through its plan.
exec_run() {
  local run="$1" engine model effort rc=1 tried="" last=""
  local -a rows=()
  mapfile -t rows < "$run/plan"
  [ "${#rows[@]}" -gt 0 ] || { echo "no rows in the model table for this task" >> "$run/stderr.log"; finish "$run" 2 none; }
  local i n="${#rows[@]}"
  for ((i = 0; i < n; i++)); do
    read -r engine model effort <<< "${rows[$i]}"
    if on_cooldown "$engine" && [ "$i" -lt "$((n - 1))" ]; then
      echo "relevo: $engine on quota cooldown, skipping" >> "$run/stderr.log"; continue
    fi
    printf 'engine=%s\nmodel=%s\neffort=%s\n' "$engine" "$model" "$effort" >> "$run/meta"
    tried="$tried $engine"; last="$engine"
    attempt "$run" "$engine" "$model" "$effort" new "$run/prompt.md"; rc=$?
    if quota_hit "$run" "$rc"; then
      echo $(( $(date +%s) + COOLDOWN )) > "$RUNS/.cooldown-$engine"
      echo "relevo: $engine out of quota or not logged in (exit=$rc)" >> "$run/stderr.log"
      continue
    fi
    rm -f "$RUNS/.cooldown-$engine"
    finish "$run" "$rc" "$engine"
  done
  echo "relevo: no engine available (tried:$tried)" >> "$run/stderr.log"
  finish "$run" "$rc" "${last:-none}"
}

detach() {
  if command -v setsid >/dev/null; then
    setsid nohup "$0" "$@" > "$RUNS/.last-runner.log" 2>&1 < /dev/null &
  else
    nohup "$0" "$@" > "$RUNS/.last-runner.log" 2>&1 < /dev/null &
  fi
}

parse_task_opts() {
  name="" dir="" lot="" ro="" sandbox="workspace-write" net=0 model="" effort=""
  engine="" kind="back" level="normal" adddirs=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -n) name="$2"; shift 2 ;;
      -C) dir="$2"; shift 2 ;;
      -E) engine="$2"; shift 2 ;;
      -k) kind="$2"; shift 2 ;;
      -l) level="$2"; shift 2 ;;
      -w) lot="$2"; shift 2 ;;
      -r) ro="$2"; shift 2 ;;
      --ro) sandbox="read-only"; shift ;;
      --full) sandbox="danger-full-access"; shift ;;
      --net) net=1; shift ;;
      --add-dir) adddirs="$adddirs $2"; shift 2 ;;
      -m) model="$2"; shift 2 ;;
      -e) effort="$2"; shift 2 ;;
      --) shift; break ;;
      -*) die "unknown option: $1" ;;
      *) break ;;
    esac
  done
  rest=("$@")
  case "$kind" in back|front|read|mech) ;; *) die "unknown kind: $kind" ;; esac
  case "$level" in facil|normal|dificil) ;; *) die "unknown level: $level" ;; esac
  case "$engine" in ""|codex|agy) ;; *) die "unknown engine: $engine" ;; esac
  [ -n "$model$effort" ] && [ -z "$engine" ] && die "-m/-e need -E (the model depends on the engine)"
}

# Prints the plan rows for the parsed options.
resolve_plan() {
  if [ -n "$model$effort" ]; then
    local row; row=$(plan_rows "$kind" "$level" "$engine" | head -1)
    local m e; read -r _ m e <<< "${row:-x - -}"
    echo "$engine ${model:-$m} ${effort:-$e}"
  else
    plan_rows "$kind" "$level" "$engine"
  fi
}

prepare() {
  parse_task_opts "$@"
  [ -n "$name" ] || die "missing -n <name>"
  [ -d "$dir" ] || die "missing existing -C <dir>"
  command -v python3 >/dev/null || die "python3 is required"
  dir=$(cd "$dir" && pwd)
  local task
  if [ "${#rest[@]}" -gt 0 ]; then task="${rest[*]}"; else task=$(cat); fi
  [ -n "$task" ] || die "empty task"
  run="$RUNS/$(date +%Y%m%d-%H%M%S)-$name"
  mkdir -p "$run"
  resolve_plan > "$run/plan"
  [ -s "$run/plan" ] || die "no row in $CONF for kind=$kind level=$level${engine:+ engine=$engine}"
  { rules "$dir" "$lot" "$ro"; printf '%s\n' "$task"; } > "$run/prompt.md"
  printf 'name=%s\ndir=%s\nsandbox=%s\nnet=%s\nkind=%s\nlevel=%s\nadddirs=%s\nstarted=%s\n' \
    "$name" "$dir" "$sandbox" "$net" "$kind" "$level" "$adddirs" "$(date -Iseconds)" > "$run/meta"
}

cmd_resume() {
  local run; run=$(resolve_run "${1:-}"); shift || true
  [ -n "$run" ] && [ -f "$run/meta" ] || die "run not found"
  [ -n "$(meta "$run" session)" ] || die "the run has no session id"
  local msg
  if [ $# -gt 0 ]; then msg="$*"; else msg=$(cat); fi
  [ -n "$msg" ] || die "empty message"
  local n; n=$(ls "$run"/resume-*.md 2>/dev/null | wc -l)
  printf '%s\n\nEnd with the same FINAL REPORT format.\n' "$msg" > "$run/resume-$((n + 1)).md"
  cp -f "$run/last.md" "$run/last-$n.md" 2>/dev/null
  rm -f "$run/exit"
  detach _resume "$run" "$run/resume-$((n + 1)).md"
  echo "$run"
}

exec_resume() {
  local run="$1" input="$2" engine rc
  engine=$(meta "$run" engine)
  attempt "$run" "$engine" "$(meta "$run" model)" "$(meta "$run" effort)" resume "$input"; rc=$?
  quota_hit "$run" "$rc" && echo $(( $(date +%s) + COOLDOWN )) > "$RUNS/.cooldown-$engine" \
    && echo "relevo: $engine out of quota; start a new run with -E <other> and pass the context" >> "$run/stderr.log"
  finish "$run" "$rc" "$engine"
}

cmd_list() {
  local r
  for r in $(ls -1d "$RUNS"/*/ 2>/dev/null | tail -n "${1:-10}"); do
    printf '%s  %-5s  %-26s  %s\n' "$(basename "$r")" "$(meta "$r" engine)" "$(meta "$r" model)" \
      "$(grep -m1 -E '^(Status|Estado):' "$r/last.md" 2>/dev/null || { [ -f "$r/exit" ] && echo 'Status: ?' || echo 'running'; })"
  done
}

cmd_status() {
  local e
  for e in codex agy; do
    if on_cooldown "$e"; then
      echo "$e: cooldown until $(date -d "@$(cat "$RUNS/.cooldown-$e")" +%H:%M 2>/dev/null || cat "$RUNS/.cooldown-$e")"
    else
      echo "$e: available"
    fi
  done
}

case "${1:-}" in
  start) shift; prepare "$@"; detach _exec "$run"; echo "$run" ;;
  run) shift; prepare "$@"; exec_run "$run" ;;
  _exec) exec_run "$2" ;;
  _resume) exec_resume "$2" "$3" ;;
  resume) shift; cmd_resume "$@" ;;
  plan) shift; parse_task_opts "$@"; resolve_plan ;;
  list) shift; cmd_list "$@" ;;
  status) cmd_status ;;
  runs) echo "$RUNS" ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
