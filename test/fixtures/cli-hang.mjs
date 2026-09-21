// Deterministic hang fixture for CliSearchBackend wall-clock timeout tests.
// Consumes the worker request on stdin, then never responds, so the backend
// wall-clock timeout fires. Killed by backend SIGTERM/SIGKILL on timeout.
process.stdin.resume();
process.stdin.on('data', () => {});
setTimeout(() => {}, 30_000);
