/**
 * The Zapier app definition: the connection, the two actions and the trigger, with the platform version it was built
 * against. `index.js` at the package root re-exports it for `zapier-platform build` / `push`.
 *
 * @example
 * ```ts
 * import zapier from "zapier-platform-core";
 * import App from "./app.js";
 * const appTester = zapier.createAppTester(App);
 * const slots = await appTester(App.triggers.slot_list.operation.perform, { authData });
 * ```
 */

import zapier from "zapier-platform-core";
import { authentication } from "./connection.js";
import { getPrompt, reportRun, rolloutChanged, slotList } from "./steps.js";

/** Zapier versions are x.y.z; this package's own version, kept in step with package.json. */
export const APP_VERSION = "0.1.0";

const App = {
  version: APP_VERSION,
  platformVersion: zapier.version,
  authentication,
  triggers: { [slotList.key]: slotList, [rolloutChanged.key]: rolloutChanged },
  searches: {},
  creates: { [getPrompt.key]: getPrompt, [reportRun.key]: reportRun },
  resources: {},
  // Every step reads its own input as given (numbers may arrive as text; each step parses what it uses).
  flags: { cleanInputData: false },
};

export default App;
