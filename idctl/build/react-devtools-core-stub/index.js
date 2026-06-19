// No-op stub for react-devtools-core. ink only calls connectToDevTools when
// process.env.DEV === 'true'; in a shipped TUI that never happens, so a no-op
// is fully sufficient. Covers both default and named import shapes.
'use strict';
function connectToDevTools() {}
module.exports = { connectToDevTools, default: { connectToDevTools } };
