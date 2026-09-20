#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { generate } from "./generate.js";
import { init } from "./init.js";
const cwd = process.cwd();
const resolve = createRequire(path.join(cwd, "package.json"));
function command(bin: string, args: string[]): ChildProcess {
  const script = bin === "tsc" ? resolve.resolve("typescript/bin/tsc") : path.join(path.dirname(resolve.resolve("vite/package.json")), "bin/vite.js");
  return spawn(process.execPath, [script, ...args], {cwd, stdio: "inherit"});
}
async function completed(child: ChildProcess): Promise<void> {
  await new Promise<void>((yes, no) => { child.once("error", no); child.once("exit", code => code === 0 ? yes() : no(new Error(`command exited ${code}`))); });
}
async function main() {
  const mode = process.argv[2] ?? "generate";
  if (mode === "init") {
    if (process.argv.length > 4) throw new Error("Usage: duet init [directory]");
    const directory = await init(process.argv[3]);
    console.log(`Created ${directory}\nNext: cd ${JSON.stringify(directory)}\nThen: npm install\n      npm run dev`);
    return;
  }
  if (!["generate", "build", "dev"].includes(mode)) throw new Error("Usage: duet init [directory] | duet generate|build|dev [config-file]");
  let result = await generate(cwd, process.argv[3]);
  if (mode === "generate") return;
  if (mode === "build") {
    await completed(command("tsc", ["-p", result.config.tsconfig ?? "tsconfig.json"]));
    if (result.config.viteConfig) await completed(command("vite", ["build", "--config", result.config.viteConfig]));
    return;
  }
  const children = new Set<ChildProcess>();
  const track = (child: ChildProcess) => {
    children.add(child);
    child.once("exit", () => children.delete(child));
    child.once("error", error => console.error(error));
    return child;
  };
  const launch = () => track(spawn(process.execPath, [fileURLToPath(new URL("./launch.js", import.meta.url)), result.appOutput], {cwd, stdio: ["pipe", "inherit", "inherit"]}));
  const typecheck = () => track(command("tsc", ["-p", result.config.tsconfig ?? "tsconfig.json", "--watch", "--noEmit"]));
  const preview = () => result.config.viteConfig ? track(command("vite", ["--config", result.config.viteConfig])) : undefined;
  const terminate = async (child?: ChildProcess) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill(); await exited;
  };
  let server = launch(), compiler = typecheck(), vite = preview();
  let timer: ReturnType<typeof setTimeout>; let busy = false, pending = false, stopping = false;
  const regenerate = async () => {
    if (stopping) return;
    if (busy) { pending = true; return; } busy = true;
    try {
      const previous = result;
      result = await generate(cwd, process.argv[3]);
      await terminate(server);
      if (stopping) return;
      server = launch();
      if (previous.config.tsconfig !== result.config.tsconfig) { await terminate(compiler); if (!stopping) compiler = typecheck(); }
      if (previous.config.viteConfig !== result.config.viteConfig) { await terminate(vite); if (!stopping) vite = preview(); }
    } catch (error) { console.error(error); }
    finally { busy = false; if (pending && !stopping) { pending = false; void regenerate(); } }
  };
  const watcher = watch(cwd, {recursive: true}, (_event, filename) => {
    if (!filename) return;
    const file = path.resolve(cwd, filename);
    // Vite handles UI changes. Restart the owner only for definition/config dependencies.
    if (!result.inputs.includes(file)) return;
    clearTimeout(timer); timer = setTimeout(() => { void regenerate(); }, 100);
  });
  const stop = () => {
    stopping = true; watcher.close(); clearTimeout(timer);
    void Promise.all([...children].map(terminate)).finally(() => process.exit(0));
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);

}
main().catch(error => { console.error(error); process.exitCode = 1; });
