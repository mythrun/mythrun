#!/usr/bin/env bash
# Test fixture: stands in for `tsx watch <entry>` when dev-logged.sh runs with
# DEV_LOGGED_RUNNER pointed here. Booting the real stack in a unit test is not
# an option (two tsx watchers, a live Postgres and two Redis connections), but
# the supervisor's teardown contract — Ctrl-C kills BOTH legs, leaving no
# orphaned watcher — is exactly the behaviour myth-q97j0 is about, so it gets
# tested against a fake leg rather than not at all.
#
# Writes its own pid to <DEV_LOGGED_LOG_DIR>/<entry-basename>.pid so the test
# can assert on the LEAF process (the one that would be tsx), not just on the
# subshell the supervisor tracks. Then blocks forever, like a real watcher.

set -uo pipefail

# The entrypoint is the last argument (dev-logged.sh passes the tsx flags
# first). bash 3.2-safe way to read it.
entry=""
for arg in "$@"; do entry="$arg"; done

name="$(basename "$entry" .ts)"
echo "$$" > "$DEV_LOGGED_LOG_DIR/$name.pid"
echo "fake-leg $name up"

while true; do sleep 0.5; done
