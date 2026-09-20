import { pathToFileURL } from "node:url";
import { runApp } from "./boot.js";
console.log = console.error; console.info = console.error; console.debug = console.error;
const { app } = await import(pathToFileURL(process.argv[2]!).href);
await runApp(app);
