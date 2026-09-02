#!/usr/bin/env bash
#
# pr-risk-scan.sh - rule-based triage of a pull request diff.
#
# No AI, no network, no third-party service: it is pattern matching over the
# lines a pull request ADDS, plus a few checks on the file list. The goal is
# not to prove a PR is safe (nothing can), it is to make sure nobody merges a
# diff containing the handful of constructs a malicious contribution needs in
# order to do damage: code execution, an install hook, an exfiltration call,
# an unreviewable binary, or a line that renders differently from how it
# compiles.
#
# Usage:
#   scripts/pr-risk-scan.sh [base-ref] [head-ref]
#
# Exit codes:
#   0  nothing blocking (warnings may still be printed)
#   1  at least one BLOCK finding
#
# Set ALLOW_BLOCKS=1 (the workflow does this when a maintainer has applied
# the `security-reviewed` label) to downgrade every BLOCK to a warning.
#
# Regex note: patterns are handed to awk as strings, so parentheses and dots
# are written as [(] and [.] rather than \( and \. to avoid escape warnings.

set -uo pipefail

BASE_REF=${1:-origin/master}
HEAD_REF=${2:-HEAD}
ALLOW_BLOCKS=${ALLOW_BLOCKS:-0}

# Hosts a diff may mention without being flagged. Anything else gets
# reported so a reviewer looks at where new code talks to.
URL_ALLOWLIST='velxio[.]dev|github[.]com|githubusercontent[.]com|npmjs[.](com|org)|nodejs[.]org|python[.]org|pypi[.]org|w3[.]org|xmlns|localhost|127[.]0[.]0[.]1|0[.]0[.]0[.]0|example[.](com|org)|wokwi[.]com|espressif[.]com|arduino[.]cc|micropython[.]org|raspberrypi[.]com|creativecommons[.]org|gnu[.]org|opensource[.]org|mozilla[.]org|schemas?[.]'

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
DIFF="$WORK/diff"
ADDED="$WORK/added"    # TSV: file <TAB> new-line-number <TAB> added text
CODE="$WORK/code"      # same, minus fixtures / lock files / vendored trees
NAMES="$WORK/names"    # status <TAB> path
blocks=0
warns=0

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "pr-risk-scan: base ref '$BASE_REF' not found" >&2
  exit 2
fi

git diff --no-color "$BASE_REF...$HEAD_REF" > "$DIFF"
git diff --name-status "$BASE_REF...$HEAD_REF" > "$NAMES"

# Added lines with their real line number in the new file. Hunk headers
# (@@ -a,b +c,d @@) give the starting line; context lines advance it,
# removed lines do not.
awk '
  /^\+\+\+ b\// { file = substr($0, 7); next }
  /^@@ / { if (match($0, /\+[0-9]+/)) n = substr($0, RSTART + 1, RLENGTH - 1) + 0; next }
  file == "" { next }
  /^\+\+\+/ { next }
  /^\+/ { printf "%s\t%d\t%s\n", file, n, substr($0, 2); n++; next }
  /^-/  { next }
  /^ /  { n++; next }
' "$DIFF" > "$ADDED"

# Generated fixtures, lock files and vendored trees are noise for the
# source-level checks; the file-level checks still cover them.
awk -F'\t' '$1 !~ /([.]min[.][a-z]+|[.]map|-lock[.]json|[.]lock|[.]snap)$/ &&
            $1 !~ /^(node_modules|third-party|frontend\/public\/wasm|prebuilt)\//' \
  "$ADDED" > "$CODE"

say() { printf '%s\n' "$*"; }

# report <BLOCK|WARN> <title> <hits-file> <why>
report() {
  local sev=$1 title=$2 hits=$3 why=$4 count kind
  count=$(wc -l < "$hits")
  [ "$count" -eq 0 ] && return 0

  if [ "$sev" = BLOCK ] && [ "$ALLOW_BLOCKS" != 1 ]; then
    blocks=$((blocks + 1)); kind=error
  else
    warns=$((warns + 1)); sev=WARN; kind=warning
  fi

  say "### [$sev] $title ($count)"
  say ""
  say "$why"
  say ""
  say '```'
  head -40 "$hits" | while IFS=$'\t' read -r f l t; do
    printf '%s:%s: %.200s\n' "$f" "$l" "$t"
  done
  [ "$count" -gt 40 ] && say "... $((count - 40)) more"
  say '```'
  # Annotations, so each finding also lands on the diff in the PR view.
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    head -20 "$hits" | while IFS=$'\t' read -r f l t; do
      printf '::%s file=%s,line=%s::%s\n' "$kind" "$f" "${l:-1}" "$title" >&2
    done
  fi
  say ""
  say "---"
  say ""
}

# match <out> <text-regex> [file-regex] - matches the text field only.
match() {
  local out=$1 re=$2 fre=${3:-.}
  awk -F'\t' -v re="$re" -v fre="$fre" '$1 ~ fre && $3 ~ re' "$CODE" > "$out"
}

say "# PR risk scan"
say ""
say "Base \`$BASE_REF\` -> head \`$HEAD_REF\`: $(grep -c . "$NAMES") files changed, $(wc -l < "$ADDED") lines added."
say ""
say "---"
say ""

############################  BLOCK-level checks  ############################

# 1. Trojan source: bidirectional overrides and invisible characters make a
#    line render differently from how the compiler reads it.
grep -P '[\x{202A}-\x{202E}\x{2066}-\x{2069}\x{200B}-\x{200F}\x{2060}\x{FEFF}]' "$ADDED" \
  > "$WORK/h" 2>/dev/null || : > "$WORK/h"
report BLOCK "Bidirectional or invisible Unicode in added lines" "$WORK/h" \
  "These characters reorder or hide source text (CVE-2021-42574, \"Trojan Source\"): what a reviewer reads is not what the compiler reads. Legitimate code never needs them."

# 2. Package-manager lifecycle hooks: the classic npm supply-chain payload.
#    It runs on every install, on your machine, before any test does.
awk -F'\t' '$1 ~ /(package[.]json|[.]npmrc|setup[.]py|pyproject[.]toml)$/ &&
            $3 ~ /"(pre|post)?install"|"prepare"|"prepublish"|cmdclass|git[+]/' \
  "$ADDED" > "$WORK/h"
report BLOCK "Install-time hook added to a package manifest" "$WORK/h" \
  "A preinstall/postinstall/prepare script executes on any machine that installs dependencies, including CI, before a single test runs."

# 3. Code execution primitives.
match "$WORK/h" 'eval[(]|new Function[(]|Function[(]"return|child_process|execSync|spawnSync|os[.]system[(]|subprocess[.](run|call|Popen|check_)|pickle[.]loads|marshal[.]loads|__import__[(]|vm[.]runInNewContext|importlib[.]import_module'
report BLOCK "Dynamic code execution or shell spawn" "$WORK/h" \
  "Frontend and library code has no reason to build code at runtime or shell out. Read every hit; if one is legitimate, the PR should say why."

# 4. Binary blobs. A binary cannot be reviewed by reading the diff.
# numstat reports binary files as "-\t-\tpath"; that is the reliable
# signal, the diff body only says "Binary files ... differ".
git diff --numstat "$BASE_REF...$HEAD_REF" \
  | awk -F'\t' '$1 == "-" && $2 == "-" { printf "%s\t1\tbinary file added or changed\n", $3 }' > "$WORK/h"
report BLOCK "Binary file in the diff" "$WORK/h" \
  "Nobody can review a binary by reading it. Ask for the source that produced it, or regenerate it yourself from that source."

# 5. Files that run a command on their own, with no human deciding to run
#    it. This is the widest hole in a PR review: the payload is never in the
#    application code, it is in the thing that executes when you check the
#    branch out, install dependencies, commit, open the editor, or point an
#    AI agent at the repository.
#
#    git's own .git/hooks cannot travel in a diff, but every modern
#    equivalent can: husky (.husky/, wired through the `prepare` script),
#    lefthook, pre-commit, core.hooksPath pointed at .githooks/, a
#    .gitattributes clean/smudge filter, direnv's .envrc, a VS Code task
#    with runOn: folderOpen, a devcontainer postCreateCommand, and a
#    Makefile target your CI calls.
awk -F'\t' '$2 ~ /^([.]github\/|[.]husky\/|[.]githooks\/|[.]pre-commit-config|lefthook|[.]envrc|[.]vscode\/|[.]devcontainer\/|[.]idea\/|Dockerfile|docker\/|docker-compose|Makefile|scripts\/|[.]gitmodules|[.]gitattributes|[.]npmrc|[.]yarnrc|[.]nvmrc|[.]cargo\/|[.]bashrc|[.]profile)/ {
              printf "%s\t1\truns automatically - not on demand (%s)\n", $2, $1 }' \
  "$NAMES" > "$WORK/h"
report BLOCK "Change to a file that executes on its own" "$WORK/h" \
  "These execute without anyone choosing to run them: on install, on commit, on checkout, on opening the editor, or in CI. Read every added line and confirm no secret or token is moved, printed or sent anywhere, and that no workflow trigger becomes pull_request_target."

# 5b. .gitattributes filters and core.hooksPath: two quiet ways to make a
#     plain \`git checkout\` or \`git add\` run a command of the author's choice.
match "$WORK/h" 'filter=|diff=|core[.]hooksPath|hooksPath'
report BLOCK "git filter or hooks path configured from the repository" "$WORK/h" \
  "A clean/smudge filter runs on checkout and on add; core.hooksPath repoints git at hooks that ship inside the repository. Neither should arrive in a contributor PR."

# 5c. Every npm script, not just the install ones. `test` and `build` run in
#     CI on the pull request itself.
awk -F'\t' '$1 ~ /package[.]json$/ &&
            ($3 ~ /"scripts"/ ||
             ($3 ~ /^[ \t]*"[a-z:_-]+"[ \t]*:[ \t]*"/ &&
              $3 !~ /"(name|version|description|license|main|module|types|type|author|homepage|repository|private|engines|packageManager)"/))' \
  "$ADDED" > "$WORK/h"
report BLOCK "npm script added or changed" "$WORK/h" \
  "Any script the CI job invokes runs the contributor's command line with the repository checked out. Read the whole command, including everything after && and |."

# 5d. Instructions aimed at an AI agent rather than at a compiler. A
#     contributor who edits these is writing into the prompt of whoever
#     reviews or builds with an agent afterwards.
awk -F'\t' '$2 ~ /(CLAUDE[.]md|AGENTS[.]md|[.]cursorrules|[.]cursor\/|[.]claude\/|[.]github\/copilot|GEMINI[.]md|[.]aider|[.]windsurfrules)/ {
              printf "%s\t1\tagent instruction file changed (%s)\n", $2, $1 }' \
  "$NAMES" > "$WORK/h"
report WARN "Instruction file for an AI agent changed" "$WORK/h" \
  "Read these as prompt injection, not as documentation: text here steers any agent later pointed at the repository, including yours."

# 6. Decode-and-run: base64 decoding in the same file as a network call.
match "$WORK/dec" 'atob[(]|b64decode|Buffer[.]from[(][^)]*base64|fromCharCode[(]|codePointAt'
match "$WORK/net" 'fetch[(]|XMLHttpRequest|WebSocket[(]|sendBeacon|axios[.]|requests[.](get|post)|urllib|curl -|wget '
cut -f1 "$WORK/dec" | sort -u > "$WORK/decf"
cut -f1 "$WORK/net" | sort -u > "$WORK/netf"
comm -12 "$WORK/decf" "$WORK/netf" > "$WORK/both"
: > "$WORK/h"
[ -s "$WORK/both" ] && awk -F'\t' 'NR==FNR { f[$0]; next } $1 in f' "$WORK/both" "$WORK/dec" > "$WORK/h"
report BLOCK "Base64 decoding in the same file as a network call" "$WORK/h" \
  "Decode a blob, then reach the network: that is the shape of a dropper. Confirm what is being decoded and where it goes."

############################  WARN-level checks  #############################

# 7. Dependency manifest changes - what is pulled in, and from where.
awk -F'\t' '$1 ~ /(package[.]json|requirements.*[.]txt|pyproject[.]toml|Pipfile|go[.]mod|Cargo[.]toml)$/ &&
            $3 ~ /[a-zA-Z0-9]/' "$ADDED" > "$WORK/h"
report WARN "Dependency manifest changed" "$WORK/h" \
  "For every added package: does it exist, is the name exactly the one you meant (typosquatting), who publishes it, how old is it, how many downloads does it have?"

# 8. New network destinations.
match "$WORK/u" 'https?://[a-zA-Z0-9.-]+|[0-9]{1,3}([.][0-9]{1,3}){3}'
awk -F'\t' -v allow="$URL_ALLOWLIST" '$3 !~ allow' "$WORK/u" > "$WORK/h"
report WARN "URL or IP address not on the allowlist" "$WORK/h" \
  "Every host new code can reach is a place data can go. Add the legitimate ones to URL_ALLOWLIST in scripts/pr-risk-scan.sh."

# 9. Credential, environment and browser-storage access.
match "$WORK/h" 'document[.]cookie|localStorage|sessionStorage|indexedDB|process[.]env|import[.]meta[.]env|os[.]environ|[.]ssh/|id_rsa|SECRET|GITHUB_TOKEN|Authorization:'
report WARN "Reads credentials, environment or browser storage" "$WORK/h" \
  "Benign on its own. Cross-check against the network destinations above: a storage read plus an outbound request is exfiltration."

# 10. DOM injection sinks.
match "$WORK/h" 'innerHTML|outerHTML|dangerouslySetInnerHTML|document[.]write|insertAdjacentHTML'
report WARN "HTML injection sink" "$WORK/h" \
  "XSS if any part of the assigned value can come from user input, a URL parameter or a saved project."

# 11. Obfuscation: minified or encoded payload hiding inside a source file.
awk -F'\t' 'length($3) > 500 && $1 !~ /[.](json|svg|xml|md|csv|txt)$/ {
              printf "%s\t%s\t<single line of %d characters>\n", $1, $2, length($3) }' \
  "$CODE" > "$WORK/h"
report WARN "Very long single line (possible minified or encoded payload)" "$WORK/h" \
  "Hand-written source does not have 500-character lines. Look at what the line actually contains."

# 12. Large additions.
git diff --numstat "$BASE_REF...$HEAD_REF" \
  | awk -F'\t' '$1 != "-" && $1 + 0 > 2000 { printf "%s\t1\t%s lines added\n", $3, $1 }' > "$WORK/h"
report WARN "Large file addition" "$WORK/h" \
  "Big generated or vendored files hide payloads well. Confirm you can regenerate each one from the source present in the PR."

##############################################################################

say "## Result"
say ""
if [ "$blocks" -gt 0 ]; then
  say "**$blocks blocking finding(s)** and $warns warning(s)."
  say ""
  say "Do not merge until every blocking finding is explained. A maintainer who"
  say "has reviewed them can add the \`security-reviewed\` label to the pull"
  say "request to let this check pass."
  exit 1
fi
say "No blocking findings, $warns warning(s) to read before merging."
say ""
say "This scan is a filter, not a proof: it sees the diff, not what the code means."
exit 0
