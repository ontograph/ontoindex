function overload(x: string): string;
function overload(x: number): number;
function overload(x: any): any {
  return "replaced";
}
