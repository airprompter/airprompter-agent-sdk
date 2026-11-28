# LangChain fixtures

`tool-loop-ts.json` is S0's fixture on the AIR-2233 schema: `createAgent` with
the AirPrompter middleware over `ChatOpenAI` and a recorded fetch
(`../../drivers/langchain.mjs`).

Every other kind LangChain owes is exempt for TypeScript in `EXEMPTIONS`
(`../../run.mjs`) until AIR-2234 moves the middleware onto the adapter
contract and adds them; AIR-2234 deletes each exemption as its fixture lands
(a kept one fails as stale). Python LangChain (AIR-2234) adds `*-py.json`
fixtures and owes every kind from its first one.
