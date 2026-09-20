// Redirect logs before importing server modules: stdout belongs to MCP.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const { runApp } = await import("duet-mcp/server");
const { app } = await import("./app.js");
await runApp(app);
