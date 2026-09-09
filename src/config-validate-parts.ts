/**
 * The pieces config validation is built from, so config-validate.ts can be the
 * composition rather than the whole of it.
 *
 * Targets are here because they carry the deepest nesting in the config, a
 * target holding routes holding states, and that one branch outweighed every
 * other field put together. The primitives sit beside it rather than in a file
 * of their own: three helpers do not earn a module, and every caller of them is
 * either here or one import away.
 */
import { LookoutError, PLATFORMS, type RouteDef, type TargetDef } from "./types.js";
import { duplicateNormalizedRoute } from "./capture/route-identity.js";

export function fail(path: string, msg: string): never {
  throw new LookoutError(`invalid lookout config (${path}): ${msg}`);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * An optional array drawn from a fixed vocabulary: `platforms`, `schemes`, and
 * anything else where the config narrows a set the code already defines.
 *
 * Undefined stays undefined, because "not said" is a different answer from "all
 * of them" and only the caller knows which one it falls back to.
 */
export function enumArray<T extends string>(
  value: unknown,
  all: readonly T[],
  name: string,
  path: string,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, `${name} must be a non-empty array of ${all.join(" | ")}`);
  }
  const one = name.replace(/s$/, "");
  for (const v of value) {
    if (!(all as readonly unknown[]).includes(v)) {
      fail(path, `${name}: unknown ${one} ${JSON.stringify(v)} (${all.join(" | ")})`);
    }
  }
  return [...new Set(value as T[])];
}

/** The targets and their routes, held to shape. Trailing slashes normalized off. */
export function validateTargets(raw: Record<string, unknown>, path: string): TargetDef[] {
  const targets = raw.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    fail(path, "targets must be a non-empty array");
  }
  const seen = new Set<string>();
  return targets.map((t, i) => {
    if (!isRecord(t)) fail(path, `targets[${i}] must be an object`);
    if (typeof t.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(t.name)) {
      fail(path, `targets[${i}].name must be a short handle (letters, digits, dashes)`);
    }
    if (seen.has(t.name)) fail(path, `duplicate target name "${t.name}"`);
    seen.add(t.name);
    if (typeof t.url !== "string") fail(path, `targets[${i}].url must be a string`);
    try {
      new URL(t.url);
    } catch {
      fail(path, `targets[${i}].url is not a valid URL: ${t.url}`);
    }
    const routes = t.routes as unknown;
    let validRoutes: (string | RouteDef)[] | undefined;
    if (routes !== undefined) {
      if (!Array.isArray(routes)) fail(path, `targets[${i}].routes must be an array`);
      validRoutes = routes.map((r, j) => {
        if (typeof r === "string") return r;
        if (!isRecord(r) || typeof r.path !== "string") {
          fail(path, `targets[${i}].routes[${j}] must be a string or { path }`);
        }
        if (r.design !== undefined && typeof r.design !== "string") {
          fail(path, `targets[${i}].routes[${j}].design must be a path string`);
        }
        for (const key of ["name", "element"] as const) {
          if (r[key] !== undefined && typeof r[key] !== "string") {
            fail(path, `targets[${i}].routes[${j}].${key} must be a string`);
          }
        }
        if (
          r.states !== undefined &&
          (!Array.isArray(r.states) || r.states.some((s) => typeof s !== "string"))
        ) {
          fail(path, `targets[${i}].routes[${j}].states must be an array of recipe names`);
        }
        if (r.navigation !== undefined && typeof r.navigation !== "boolean") {
          fail(path, `targets[${i}].routes[${j}].navigation must be a boolean`);
        }
        if (r.provenance !== undefined && typeof r.provenance !== "boolean") {
          fail(path, `targets[${i}].routes[${j}].provenance must be a boolean`);
        }
        const platforms = enumArray(r.platforms, PLATFORMS, `targets[${i}].routes[${j}].platforms`, path);
        return { ...r, ...(platforms ? { platforms } : {}) } as unknown as RouteDef;
      });
      const duplicate = duplicateNormalizedRoute(validRoutes);
      if (duplicate) {
        fail(
          path,
          `targets[${i}].routes[${duplicate.index}] duplicates routes[${duplicate.prior}] after normalization (${duplicate.route})`,
        );
      }
    }
    const signIn = t.signIn;
    if (signIn !== undefined && typeof signIn !== "function") {
      fail(path, `targets[${i}].signIn must be a function (page) => Promise<void>`);
    }
    let query: Record<string, string> | undefined;
    if (t.query !== undefined) {
      if (!isRecord(t.query)) fail(path, `targets[${i}].query must be an object of strings`);
      query = {};
      for (const [k, v] of Object.entries(t.query)) {
        if (typeof v !== "string") fail(path, `targets[${i}].query.${k} must be a string`);
        query[k] = v;
      }
    }
    return {
      name: t.name,
      url: t.url.replace(/\/$/, ""),
      routes: validRoutes,
      readyPath: typeof t.readyPath === "string" ? t.readyPath : undefined,
      startHint: typeof t.startHint === "string" ? t.startHint : undefined,
      query,
      signIn: signIn as TargetDef["signIn"],
    };
  });
}
