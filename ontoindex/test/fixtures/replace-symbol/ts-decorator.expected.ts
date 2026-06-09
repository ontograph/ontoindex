function logged(target: any, key: string, descriptor: PropertyDescriptor) {
  return descriptor;
}

class Test {
  @logged
  method() {
    return "replaced";
  }
}
