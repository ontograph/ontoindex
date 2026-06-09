int unsafe_pipe() {
  int fds[2];
  if (pipe(fds) != 0) return -1;
  close(fds[0]);
  return fds[1];
}

int safe_pipe() {
  int fds[2];
  if (pipe2(fds, O_CLOEXEC) != 0) return -1;
  close(fds[0]);
  close(fds[1]);
  return 0;
}
