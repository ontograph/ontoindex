#!/bin/sh
# Run a command with ONTOINDEX_TEST_CGROUP_ROOT pointing at a writable,
# CPU-enabled cgroup inside a delegated systemd user scope.
# Usage: scripts/run-in-delegated-cgroup.sh <command> [args...]
set -eu
if [ -z "${ONTOINDEX_IN_DELEGATED_SCOPE:-}" ]; then
  exec env ONTOINDEX_IN_DELEGATED_SCOPE=1 systemd-run --user --scope --quiet \
    -p Delegate=yes -- "$0" "$@"
fi
scope="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)"
# A cgroup with member processes cannot enable controllers for children, so
# move this shell into a leaf first, then delegate cpu to a sibling work root.
mkdir "$scope/runner"
echo $$ > "$scope/runner/cgroup.procs"
echo +cpu > "$scope/cgroup.subtree_control"
mkdir "$scope/work"
echo +cpu > "$scope/work/cgroup.subtree_control"
export ONTOINDEX_TEST_CGROUP_ROOT="$scope/work"
exec "$@"
