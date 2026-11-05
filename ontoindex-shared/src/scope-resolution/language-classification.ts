/**
 * `LanguageClassification` — RFC §6.1 Ring 3 / Ring 4 governance.
 *
 * Classifies each `SupportedLanguages` member. This was the rollout gate for
 * the registry-primary scope reader; OntoIndex removed that reader, so the
 * classification is historical and has no consumer in the indexer.
 *
 * Initial classification (locked in Ring 1 #910):
 *   - production: javascript, typescript, python, java, c, cpp, csharp, go,
 *                 ruby, rust, php, kotlin, swift, dart
 *   - experimental: vue (embedded-language / SFC complexity),
 *                   cobol (regex-provider path)
 *   - quarantined: (none)
 */

import { SupportedLanguages } from '../languages.js';

export type LanguageClassification = 'production' | 'experimental' | 'quarantined';

/**
 * The canonical classification for each supported language. Governance
 * changes (promote `experimental` → `production`, quarantine a language, …)
 * update this map in a dedicated PR.
 */
export const LanguageClassifications: Readonly<Record<SupportedLanguages, LanguageClassification>> =
  {
    [SupportedLanguages.JavaScript]: 'production',
    [SupportedLanguages.TypeScript]: 'production',
    [SupportedLanguages.Python]: 'production',
    [SupportedLanguages.Java]: 'production',
    [SupportedLanguages.C]: 'production',
    [SupportedLanguages.CPlusPlus]: 'production',
    [SupportedLanguages.CSharp]: 'production',
    [SupportedLanguages.Go]: 'production',
    [SupportedLanguages.Ruby]: 'production',
    [SupportedLanguages.Rust]: 'production',
    [SupportedLanguages.PHP]: 'production',
    [SupportedLanguages.Kotlin]: 'production',
    [SupportedLanguages.Swift]: 'production',
    [SupportedLanguages.Dart]: 'production',
    [SupportedLanguages.Vue]: 'experimental',
    [SupportedLanguages.Cobol]: 'experimental',
  };

/** Convenience predicate: is this language gating Ring 4 retirement? */
export function isProductionLanguage(lang: SupportedLanguages): boolean {
  return LanguageClassifications[lang] === 'production';
}
