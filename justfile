# Repository task entry points (Linux only).

# Rust unit tests for the optional native kernels.
test-native *args:
    CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" cargo test --manifest-path ontoindex-native/Cargo.toml --lib {{args}}

# cgroup-gated CPU tests, run inside a delegated systemd user scope.
test-cgroup *args:
    cd ontoindex && scripts/run-in-delegated-cgroup.sh npx vitest run test/unit/overlay-benchmark-automatic.test.ts {{args}}
