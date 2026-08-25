/**
 * Library surface: the types a .lookout/config.ts imports, plus the loaders
 * other tools may embed. The CLI is the primary interface; this keeps configs
 * type-checked in consumer repos.
 */
export type {
  FormFactor,
  Scheme,
  PlatformKind,
  Severity,
  Viewport,
  RouteDef,
  TargetDef,
  SchemeConfig,
  StateRecipe,
  NativeAppConfig,
  LookoutConfig,
  ResolvedConfig,
  DeterministicFinding,
  ShotRecord,
  RunRecord,
  CaptureReport,
} from "./types.js";
export { DEFAULT_VIEWPORTS, LookoutError } from "./types.js";
export { loadConfig, validateConfig, assertTargetsAllowed } from "./config.js";
export { resolveTargets, resolveRoutes, preflight } from "./targets.js";
