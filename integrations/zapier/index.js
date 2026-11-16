/**
 * The entry `zapier-platform build` and `push` load: the compiled app (`npm run build` writes `dist/`).
 *
 * @example
 * ```sh
 * npm run build && npx zapier-platform validate
 * ```
 */
export { default } from "./dist/zapier/app.js";
