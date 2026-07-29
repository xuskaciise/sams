import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone Node.js worker (its own package.json/deps) — not part of
    // this Next.js/React app, so React-specific rules (hooks, etc.) don't
    // apply and would false-positive on names like useMultiFileAuthState.
    "whatsapp-service/**",
  ]),
]);

export default eslintConfig;
