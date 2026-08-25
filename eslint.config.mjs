// Focused ESLint flat config for a bun-first TypeScript CLI. Not a style linter:
// tsc carries the type discipline; this enables only the rule classes that catch
// real bugs in async/subprocess-heavy code.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".lookout/**"] },
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
