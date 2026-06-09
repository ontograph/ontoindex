/**
 * Type and Call Resolution Interfaces
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface TypeResolver {
  /**
   * Resolve the type name of a variable or expression at a specific location.
   */
  resolveType(expression: string, location: { filePath: string; line: number }): string | null;

  /**
   * Resolve all type bindings available in a file scope.
   */
  getFileScopeBindings(filePath: string): Array<[string, string]>;
}

export interface CallResolver {
  /**
   * Resolve the target symbol(s) of a call site.
   */
  resolveCall(call: { calledName: string; receiverTypeName?: string; argCount?: number }): string[];
}
