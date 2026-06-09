int fork_failure() {
  int fd = open("/tmp/data", O_RDONLY);
  pid_t pid = fork();
  if (pid == 0) {
    execl("/bin/echo", "echo", "child", nullptr);
  }
  waitpid(pid, nullptr, 0);
  close(fd);
  return 0;
}
