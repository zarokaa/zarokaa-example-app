# The Zarokaa app bridge

These two files are the app bridge SDK — the only supported way for an embedded
app to talk to its Zarokaa host. They are checked in so this example runs with
`npm install && npm start` and no build step.

**The bridge is not published to the public npm registry.** Copy `index.js` and
`protocol.js` into your own project and import them from there:

```js
import { createApp } from "./app-bridge/index.js";
```

This example is deliberately bundler-free, so it serves these files to the
browser as one ES module (see `src/server.js`, the `/vendor/app-bridge.js`
route). An app with a bundler imports the copied files directly and does not
need that trick.

The `--polygon-*` names in `protocol.js` are the theme variables the host sends;
they are part of the platform's wire protocol and are used exactly as written.
