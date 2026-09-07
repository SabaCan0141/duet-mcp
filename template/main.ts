// Static ESM imports run before console redirection.
// Any extra stdout output can break JSON-RPC. Keep this entry point limited to
// redirecting console output and dynamically importing the application.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

await import("./start.js");
