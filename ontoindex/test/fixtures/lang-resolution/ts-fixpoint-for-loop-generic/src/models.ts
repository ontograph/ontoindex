export class User {
  save(): void {}
}
export class Admin {
  save(): void {}
}
export function getUsers(): Array<User> {
  return [];
}
export function getUserSet(): ReadonlySet<User> {
  return new Set();
}
export function getIndex(): Map<string, Admin> {
  return new Map();
}
