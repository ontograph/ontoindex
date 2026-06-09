function overload(x: string): string;
function overload(x: number): number;
function overload(x: any): any {
  if (typeof x === "string") {
    return x.toUpperCase();
  }
  return x * 2;
}
