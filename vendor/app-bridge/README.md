# The Zarokaa app bridge (`@polygon/app-bridge`)

These two files are an unmodified copy of the app bridge SDK's source, checked
in so this example runs with `npm install && npm start` and no build step.

**The bridge is not published to the public npm registry.** Do not
`npm install @polygon/app-bridge` — that name is not ours on npmjs.com, and
whatever it resolves to there is not this SDK. Copy `index.js` and
`protocol.js` into your own project instead and import them from there:

```js
import { createApp } from "./app-bridge/index.js";
```

The `@polygon/` name, the `--polygon-*` theme tokens and the `X-Polygon-*`
headers are wire-protocol identifiers kept from before the product was named
Zarokaa; they are stable and will not change under you.

This example is deliberately bundler-free, so it serves these files to the
browser as one ES module (see `src/server.js`, the `/vendor/app-bridge.js`
route). An app with a bundler imports the copied files directly and does not
need that trick.
