/**
 * Language Processor Port Interface
 *
 * Defines the contract for parsing source code and extracting graph elements.
 * Formalizes the existing LanguageProvider interface.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupportedLanguages } from '../languages.js';

export interface ExtractionResult {
  nodes: unknown[];
  relationships: unknown[];
  symbols: unknown[];
  imports: unknown[];
  calls: unknown[];
}

export interface LanguageProcessor {
  /** The language this processor handles. */
  readonly language: SupportedLanguages;

  /**
   * Parse a file and return the code graph artifacts.
   */
  extract(content: string, filePath: string): Promise<ExtractionResult>;

  /**
   * Check if this processor supports a specific file extension or path.
   */
  supports(filePath: string): boolean;
}
