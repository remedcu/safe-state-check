import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import { defineConfig, globalIgnores } from "eslint/config"
import globals from "globals"
import tseslint from "typescript-eslint"

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
  },
  // Layer boundaries (docs/ARCHITECTURE.md section 3). Imports across layers use the @/ alias so these rules see them.
  {
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@/data/types", message: "core may only import types from data.", allowTypeImports: true }],
          patterns: [
            {
              group: ["@/data/*", "!@/data/types", "@/check/*", "@/ui/*"],
              message: "core imports no I/O, check or UI.",
            },
            { group: ["../*"], message: "Use the @/ alias." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/data/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/check/*", "@/ui/*"], message: "data imports only core." },
            { group: ["../*"], message: "Use the @/ alias." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/check/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/ui/*"], message: "check never imports UI." },
            { group: ["../*"], message: "Use the @/ alias." },
          ],
        },
      ],
    },
  },
])
