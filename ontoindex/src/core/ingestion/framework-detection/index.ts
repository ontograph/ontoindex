/**
 * Framework Detection — index
 *
 * Re-exports all public types and per-language detectors.
 * Contains the router `detectFrameworkFromPath` that delegates to per-language modules.
 */

import { SupportedLanguages } from 'ontoindex-shared';

export type { FrameworkHint } from './types.js';

import type { FrameworkHint } from './types.js';
import { detectTsFramework } from './ts-frameworks.js';
import { detectPythonFramework } from './python-frameworks.js';
import { detectJavaFramework } from './java-frameworks.js';
import { detectKotlinFramework } from './kotlin-frameworks.js';
import { detectCsharpFramework } from './csharp-frameworks.js';
import { detectGoFramework } from './go-frameworks.js';
import { detectRustFramework } from './rust-frameworks.js';
import { detectCCppFramework } from './c-cpp-frameworks.js';
import { detectPhpFramework } from './php-frameworks.js';
import { detectRubyFramework } from './ruby-frameworks.js';
import { detectSwiftFramework } from './swift-frameworks.js';
import { detectDartFramework } from './dart-frameworks.js';

// ============================================================================
// PATH-BASED FRAMEWORK DETECTION ROUTER
// ============================================================================

/**
 * Detect framework from file path patterns.
 *
 * Delegates to per-language detector modules.
 * Returns null if no framework pattern is detected (falls back to 1.0 multiplier).
 */
export function detectFrameworkFromPath(filePath: string): FrameworkHint | null {
  // Normalize path separators and ensure leading slash for consistent matching
  const originalPath = filePath.replace(/\\/g, '/');
  let p = originalPath.toLowerCase();
  if (!p.startsWith('/')) {
    p = '/' + p; // Add leading slash so patterns like '/app/' match 'app/...'
  }
  const originalPathWithLeadingSlash = originalPath.startsWith('/')
    ? originalPath
    : `/${originalPath}`;

  return (
    detectTsFramework(p, originalPathWithLeadingSlash) ??
    detectPythonFramework(p) ??
    detectJavaFramework(p) ??
    detectKotlinFramework(p) ??
    detectCsharpFramework(p) ??
    detectGoFramework(p) ??
    detectRustFramework(p) ??
    detectCCppFramework(p) ??
    detectPhpFramework(p) ??
    detectRubyFramework(p) ??
    detectSwiftFramework(p) ??
    detectDartFramework(p) ??
    detectGenericPatterns(p)
  );
}

/** Generic cross-language patterns checked last. */
function detectGenericPatterns(p: string): FrameworkHint | null {
  // Any language: index files in API folders
  if (
    p.includes('/api/') &&
    (p.endsWith('/index.ts') || p.endsWith('/index.js') || p.endsWith('/__init__.py'))
  ) {
    return { framework: 'api', entryPointMultiplier: 1.8, reason: 'api-index' };
  }
  return null;
}

// ============================================================================
// AST-BASED FRAMEWORK DETECTION
// ============================================================================

/**
 * Patterns that indicate framework entry points within code definitions.
 * These are matched against AST node text (class/method/function declaration text).
 */
export const FRAMEWORK_AST_PATTERNS = {
  // JavaScript/TypeScript decorators
  nestjs: ['@Controller', '@Get', '@Post', '@Put', '@Delete', '@Patch'],
  'expo-router': [
    'router.push',
    'router.replace',
    'router.navigate',
    'useRouter',
    'useLocalSearchParams',
    'useSegments',
    'expo-router',
  ],
  express: ['app.get', 'app.post', 'app.put', 'app.delete', 'router.get', 'router.post'],

  // Python decorators
  fastapi: ['@app.get', '@app.post', '@app.put', '@app.delete', '@router.get'],
  flask: ['@app.route', '@blueprint.route'],

  // Java annotations
  spring: ['@RestController', '@Controller', '@GetMapping', '@PostMapping', '@RequestMapping'],
  jaxrs: ['@Path', '@GET', '@POST', '@PUT', '@DELETE'],

  // C# attributes
  aspnet: [
    '[ApiController]',
    '[HttpGet]',
    '[HttpPost]',
    '[HttpPut]',
    '[HttpDelete]',
    '[Route]',
    '[Authorize]',
    '[AllowAnonymous]',
  ],
  signalr: ['[HubMethodName]', ': Hub', ': Hub<'],
  blazor: ['@page', '[Parameter]', '@inject'],
  efcore: ['DbContext', 'DbSet<', 'OnModelCreating'],

  // Go patterns (function signatures include framework types)
  'go-http': [
    'http.Handler',
    'http.HandlerFunc',
    'ServeHTTP',
    'http.ResponseWriter',
    'http.Request',
  ],
  gin: ['gin.Context', 'gin.Default', 'gin.New'],
  echo: ['echo.Context', 'echo.New'],
  fiber: ['fiber.Ctx', 'fiber.New', 'fiber.App'],
  'go-grpc': ['grpc.Server', 'RegisterServer', 'pb.Unimplemented'],

  // ORM patterns
  prisma: ['prisma.', 'PrismaClient', '@prisma/client'],
  supabase: ['supabase.from', 'createClient', '@supabase/supabase-js'],

  // PHP/Laravel
  laravel: [
    'Route::get',
    'Route::post',
    'Route::put',
    'Route::delete',
    'Route::resource',
    'Route::apiResource',
    '#[Route(',
  ],

  // Rust macros (proc-macro attributes in definition text)
  actix: ['#[get', '#[post', '#[put', '#[delete', '#[actix_web', 'HttpRequest', 'HttpResponse'],
  axum: ['Router::new', 'axum::extract', 'axum::routing'],
  rocket: ['#[get', '#[post', '#[launch', 'rocket::'],
  tokio: ['#[tokio::main]', '#[tokio::test]'],

  // C++ patterns (Qt, Boost)
  qt: [
    'Q_OBJECT',
    'Q_INVOKABLE',
    'Q_PROPERTY',
    'Q_SIGNALS',
    'Q_SLOTS',
    'Q_SIGNAL',
    'Q_SLOT',
    'QWidget',
    'QApplication',
  ],

  // Swift/iOS
  uikit: [
    'viewDidLoad',
    'viewWillAppear',
    'viewDidAppear',
    'UIViewController',
    '@IBOutlet',
    '@IBAction',
    '@objc',
  ],
  swiftui: [
    '@main',
    'WindowGroup',
    'ContentView',
    '@StateObject',
    '@ObservedObject',
    '@EnvironmentObject',
    '@Published',
  ],
  vapor: ['app.get', 'app.post', 'req.content.decode', 'Vapor'],

  // Ruby patterns (class-level macros in definition text)
  rails: [
    'ApplicationController',
    'ApplicationRecord',
    'ActiveRecord::Base',
    'before_action',
    'after_action',
    'has_many',
    'belongs_to',
    'has_one',
    'validates',
  ],
  sinatra: ['Sinatra::Base', 'Sinatra::Application'],

  // Dart/Flutter
  flutter: [
    'StatelessWidget',
    'StatefulWidget',
    'BuildContext',
    'Widget build',
    'ChangeNotifier',
    'GetxController',
    'Cubit<',
    'Bloc<',
    'ConsumerWidget',
  ],
  riverpod: ['@riverpod', 'ref.watch', 'ref.read', 'AsyncNotifier', 'Notifier'],
};

interface AstFrameworkPatternConfig {
  framework: string;
  entryPointMultiplier: number;
  reason: string;
  patterns: string[];
}

export const AST_FRAMEWORK_PATTERNS_BY_LANGUAGE = {
  [SupportedLanguages.JavaScript]: [
    {
      framework: 'nestjs',
      entryPointMultiplier: 3.2,
      reason: 'nestjs-decorator',
      patterns: FRAMEWORK_AST_PATTERNS.nestjs,
    },
    {
      framework: 'expo-router',
      entryPointMultiplier: 2.5,
      reason: 'expo-router-navigation',
      patterns: FRAMEWORK_AST_PATTERNS['expo-router'],
    },
  ],
  [SupportedLanguages.TypeScript]: [
    {
      framework: 'nestjs',
      entryPointMultiplier: 3.2,
      reason: 'nestjs-decorator',
      patterns: FRAMEWORK_AST_PATTERNS.nestjs,
    },
    {
      framework: 'expo-router',
      entryPointMultiplier: 2.5,
      reason: 'expo-router-navigation',
      patterns: FRAMEWORK_AST_PATTERNS['expo-router'],
    },
  ],
  [SupportedLanguages.Python]: [
    {
      framework: 'fastapi',
      entryPointMultiplier: 3.0,
      reason: 'fastapi-decorator',
      patterns: FRAMEWORK_AST_PATTERNS.fastapi,
    },
    {
      framework: 'flask',
      entryPointMultiplier: 2.8,
      reason: 'flask-decorator',
      patterns: FRAMEWORK_AST_PATTERNS.flask,
    },
  ],
  [SupportedLanguages.Java]: [
    {
      framework: 'spring',
      entryPointMultiplier: 3.2,
      reason: 'spring-annotation',
      patterns: FRAMEWORK_AST_PATTERNS.spring,
    },
    {
      framework: 'jaxrs',
      entryPointMultiplier: 3.0,
      reason: 'jaxrs-annotation',
      patterns: FRAMEWORK_AST_PATTERNS.jaxrs,
    },
  ],
  [SupportedLanguages.Kotlin]: [
    {
      framework: 'spring-kotlin',
      entryPointMultiplier: 3.2,
      reason: 'spring-kotlin-annotation',
      patterns: FRAMEWORK_AST_PATTERNS.spring,
    },
    {
      framework: 'jaxrs',
      entryPointMultiplier: 3.0,
      reason: 'jaxrs-annotation',
      patterns: FRAMEWORK_AST_PATTERNS.jaxrs,
    },
    {
      framework: 'ktor',
      entryPointMultiplier: 2.8,
      reason: 'ktor-routing',
      patterns: ['routing', 'embeddedServer', 'Application.module'],
    },
    {
      framework: 'android-kotlin',
      entryPointMultiplier: 2.5,
      reason: 'android-annotation',
      patterns: ['@AndroidEntryPoint', 'AppCompatActivity', 'Fragment('],
    },
  ],
  [SupportedLanguages.CSharp]: [
    {
      framework: 'aspnet',
      entryPointMultiplier: 3.2,
      reason: 'aspnet-attribute',
      patterns: FRAMEWORK_AST_PATTERNS.aspnet,
    },
    {
      framework: 'signalr',
      entryPointMultiplier: 2.8,
      reason: 'signalr-attribute',
      patterns: FRAMEWORK_AST_PATTERNS.signalr,
    },
    {
      framework: 'blazor',
      entryPointMultiplier: 2.5,
      reason: 'blazor-attribute',
      patterns: FRAMEWORK_AST_PATTERNS.blazor,
    },
    {
      framework: 'efcore',
      entryPointMultiplier: 2.0,
      reason: 'efcore-pattern',
      patterns: FRAMEWORK_AST_PATTERNS.efcore,
    },
  ],
  [SupportedLanguages.PHP]: [
    {
      framework: 'laravel',
      entryPointMultiplier: 3.0,
      reason: 'php-route-attribute',
      patterns: FRAMEWORK_AST_PATTERNS.laravel,
    },
  ],
  [SupportedLanguages.Go]: [
    {
      framework: 'go-http',
      entryPointMultiplier: 2.5,
      reason: 'go-http-handler',
      patterns: FRAMEWORK_AST_PATTERNS['go-http'],
    },
    {
      framework: 'gin',
      entryPointMultiplier: 3.0,
      reason: 'gin-handler',
      patterns: FRAMEWORK_AST_PATTERNS.gin,
    },
    {
      framework: 'echo',
      entryPointMultiplier: 3.0,
      reason: 'echo-handler',
      patterns: FRAMEWORK_AST_PATTERNS.echo,
    },
    {
      framework: 'fiber',
      entryPointMultiplier: 3.0,
      reason: 'fiber-handler',
      patterns: FRAMEWORK_AST_PATTERNS.fiber,
    },
    {
      framework: 'go-grpc',
      entryPointMultiplier: 2.8,
      reason: 'grpc-service',
      patterns: FRAMEWORK_AST_PATTERNS['go-grpc'],
    },
  ],
  [SupportedLanguages.Rust]: [
    {
      framework: 'actix-web',
      entryPointMultiplier: 3.0,
      reason: 'actix-attribute',
      patterns: FRAMEWORK_AST_PATTERNS.actix,
    },
    {
      framework: 'axum',
      entryPointMultiplier: 3.0,
      reason: 'axum-routing',
      patterns: FRAMEWORK_AST_PATTERNS.axum,
    },
    {
      framework: 'rocket',
      entryPointMultiplier: 3.0,
      reason: 'rocket-attribute',
      patterns: FRAMEWORK_AST_PATTERNS.rocket,
    },
    {
      framework: 'tokio',
      entryPointMultiplier: 2.5,
      reason: 'tokio-runtime',
      patterns: FRAMEWORK_AST_PATTERNS.tokio,
    },
  ],
  [SupportedLanguages.C]: [], // C has no framework-specific AST patterns (POSIX/socket patterns are in entry-point-scoring)
  [SupportedLanguages.CPlusPlus]: [
    {
      framework: 'qt',
      entryPointMultiplier: 2.8,
      reason: 'qt-macro',
      patterns: FRAMEWORK_AST_PATTERNS.qt,
    },
  ],
  [SupportedLanguages.Swift]: [
    {
      framework: 'uikit',
      entryPointMultiplier: 2.5,
      reason: 'uikit-lifecycle',
      patterns: FRAMEWORK_AST_PATTERNS.uikit,
    },
    {
      framework: 'swiftui',
      entryPointMultiplier: 2.8,
      reason: 'swiftui-pattern',
      patterns: FRAMEWORK_AST_PATTERNS.swiftui,
    },
    {
      framework: 'vapor',
      entryPointMultiplier: 3.0,
      reason: 'vapor-routing',
      patterns: FRAMEWORK_AST_PATTERNS.vapor,
    },
  ],
  [SupportedLanguages.Ruby]: [
    {
      framework: 'rails',
      entryPointMultiplier: 3.0,
      reason: 'rails-pattern',
      patterns: FRAMEWORK_AST_PATTERNS.rails,
    },
    {
      framework: 'sinatra',
      entryPointMultiplier: 2.8,
      reason: 'sinatra-pattern',
      patterns: FRAMEWORK_AST_PATTERNS.sinatra,
    },
  ],
  [SupportedLanguages.Dart]: [
    {
      framework: 'flutter',
      entryPointMultiplier: 2.5,
      reason: 'flutter-widget',
      patterns: FRAMEWORK_AST_PATTERNS.flutter,
    },
    {
      framework: 'riverpod',
      entryPointMultiplier: 2.8,
      reason: 'riverpod-pattern',
      patterns: FRAMEWORK_AST_PATTERNS.riverpod,
    },
  ],
  [SupportedLanguages.Vue]: [], // Vue uses TypeScript AST framework detection
  [SupportedLanguages.Cobol]: [], // Standalone regex processor — no AST framework patterns
} satisfies Record<SupportedLanguages, AstFrameworkPatternConfig[]>;

/** Pre-lowercased patterns for O(1) pattern matching at runtime */
const AST_PATTERNS_LOWERED: Record<
  string,
  Array<{ framework: string; entryPointMultiplier: number; reason: string; patterns: string[] }>
> = Object.fromEntries(
  Object.entries(AST_FRAMEWORK_PATTERNS_BY_LANGUAGE).map(([lang, cfgs]) => [
    lang,
    cfgs.map((cfg) => ({ ...cfg, patterns: cfg.patterns.map((p) => p.toLowerCase()) })),
  ]),
);

/**
 * Detect framework entry points from AST definition text (decorators/annotations/attributes).
 * Returns null if no known pattern is found.
 * Note: callers should slice definitionText to ~300 chars since annotations appear at the start.
 */
export function detectFrameworkFromAST(
  language: SupportedLanguages,
  definitionText: string,
): FrameworkHint | null {
  if (!language || !definitionText) return null;

  const configs = AST_PATTERNS_LOWERED[language.toLowerCase()];
  if (!configs || configs.length === 0) return null;

  const normalized = definitionText.toLowerCase();

  for (const cfg of configs) {
    for (const pattern of cfg.patterns) {
      if (normalized.includes(pattern)) {
        return {
          framework: cfg.framework,
          entryPointMultiplier: cfg.entryPointMultiplier,
          reason: cfg.reason,
        };
      }
    }
  }

  return null;
}
