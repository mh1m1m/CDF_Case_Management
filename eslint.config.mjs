// Flat ESLint config for the whole monorepo.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

const SUPABASE_BOUNDARY = {
  // ADR-009 / CLAUDE.md §3: Supabase SDKs are infrastructure adapters only.
  paths: [],
  patterns: [
    {
      group: ["@supabase/*"],
      message: "Supabase SDKs may only be imported inside packages/infrastructure (ADR-009).",
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "baseline/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-imports": ["error", SUPABASE_BOUNDARY],
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["packages/infrastructure/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Pure packages must not depend on frameworks or infrastructure.
    files: [
      "packages/domain/**/*.ts",
      "packages/workflow/**/*.ts",
      "packages/authorization/**/*.ts",
      "packages/contracts/**/*.ts",
      "packages/validation/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@supabase/*", "postgres", "next", "next/*", "react"],
              message: "Pure packages cannot import infrastructure or frameworks.",
            },
            {
              group: ["@cdf/application", "@cdf/infrastructure", "@cdf/ui"],
              message: "Pure packages cannot depend on outer layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML is prohibited (threat T14).",
        },
      ],
      "@next/next/no-html-link-for-pages": "off",
    },
  },
);
