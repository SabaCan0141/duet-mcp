import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../lib/cli.js", import.meta.url));
test("init creates source and scripts without generated artifacts and never overwrites a project", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "duet-init-"));
  try {
    const project = path.join(directory, "My App");
    await exec(process.execPath, [cli, "init", project], {cwd: directory});
    const pkg = JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8"));
    assert.equal(pkg.type, "module");
    assert.equal(pkg.name, "my-app");
    assert.equal(pkg.scripts.dev, "duet dev");
    const metadata = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.dependencies["duet-mcp"], `^${metadata.version}`);
    assert.equal(pkg.version, "0.1.0");
    assert(pkg.devDependencies["@tailwindcss/vite"]);
    const appPath = path.join(project, "template/app.ts");
    const app = await fs.readFile(appPath, "utf8");
    assert(app.includes('id: "my-app"'));
    assert.equal(app.match(/^  version: "([^"]*)",$/m)?.[1], pkg.version);
    for (const name of ["duet", ".duet", "ui/dist"]) {
      await assert.rejects(fs.access(path.join(project, "template", name)), {code:"ENOENT"});
    }
    await assert.rejects(exec(process.execPath, [cli, "init", project]), /empty directory/);
    assert.equal(await fs.readFile(appPath, "utf8"), app);
    const occupied = path.join(directory, "occupied");await fs.mkdir(occupied);
    await fs.writeFile(path.join(occupied, "keep.txt"), "keep");
    await assert.rejects(exec(process.execPath, [cli, "init"], {cwd: occupied}), /empty directory/);
    assert.deepEqual(await fs.readdir(occupied), ["keep.txt"]);
    const empty = path.join(directory, "empty");await fs.mkdir(empty);
    await exec(process.execPath, [cli, "init"], {cwd: empty});
    await fs.access(path.join(empty, "duet.config.ts"));
  } finally { await fs.rm(directory, {recursive:true,force:true}); }
});
