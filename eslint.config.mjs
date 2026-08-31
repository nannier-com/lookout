// Focused ESLint flat config for a bun-first TypeScript CLI. Not a style linter:
// tsc carries the type discipline; this enables only the rule classes that catch
// real bugs in async/subprocess-heavy code.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .claude holds other sessions' worktrees, each with its own build output.
  // Linting a sibling checkout's dist is both meaningless and, because that
  // build is JavaScript without node globals declared, noisy enough to bury
  // this repo's own findings.
  { ignores: ["dist/**", "node_modules/**", ".lookout/**", ".claude/**", "**/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS node scripts (licensegen): give core rules the node globals so
    // no-undef stops flagging URL/console; TS files get this from the compiler.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly", Buffer: "readonly" }
    }
  },
  {
    // The page's own script runs in a browser, and nothing in the type system
    // says so: the compiler is configured with node's globals for the CLI, and
    // would happily accept `process.env` in code served to Chrome. These two
    // rules are what makes the boundary real.
    files: ["src/ui/client/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "process", message: "the client runs in a browser: there is no process here" },
        { name: "Buffer", message: "the client runs in a browser: there is no Buffer here" },
        { name: "require", message: "the client is an ES module served to a browser" },
        { name: "__dirname", message: "the client runs in a browser: there is no __dirname here" },
      ],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../**"],
              allowTypeImports: true,
              message:
                "the client is served to a browser and cannot load server modules; " +
                "import them as types only, so the import is erased",
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      // Forgotten awaits in capture/judge pipelines produce silent misorderings.
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // The CLI intentionally prints; console is the product surface.
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  }
);
