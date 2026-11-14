import { defineConfig } from "vite-plus"

const noEdge = { group: ["**/edge", "**/edge/**"], message: "Modules must not import edge adapters (src/edge)." }
const noActions = { group: ["**/actions", "**/actions/**"], message: "Only edge adapters import actions." }

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
  lint: {
    overrides: [
      {
        files: ["src/**/*.ts"],
        excludeFiles: ["src/edge/**"],
        rules: { "no-restricted-imports": ["error", { patterns: [noEdge] }] },
      },
      {
        files: ["src/projects/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                noEdge,
                { group: ["**/signals", "**/signals/**"], message: "projects must not import signals." },
                noActions,
              ],
            },
          ],
        },
      },
      {
        files: ["src/signals/**/*.ts"],
        rules: { "no-restricted-imports": ["error", { patterns: [noEdge, noActions] }] },
      },
      {
        files: ["src/actions/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                noEdge,
                { group: ["**/projects", "**/projects/**"], message: "actions must not import projects." },
                { group: ["**/signals/**", "**/db"], message: "actions uses only the signals interface (../signals)." },
              ],
            },
          ],
        },
      },
    ],
  },
})
