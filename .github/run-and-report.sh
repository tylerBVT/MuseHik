#!/usr/bin/env bash
# Runs a command; when it fails, its last 60 lines become an error annotation on the run, readable without signing in
# (GitHub only shows full logs to the repository's admins). Usage: bash .github/run-and-report.sh "<title>" <command...>
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  body="$(tail -n 60 "$log" | sed -e 's/%/%25/g' -e 's/\r//g' | awk '{printf "%s%%0A", $0}')"
  echo "::error title=${title} failed (exit ${code})::${body}"
fi
exit "$code"
