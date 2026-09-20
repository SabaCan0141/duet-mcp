import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Create an editable project without installing packages or overwriting files. */
export async function init(directory = "."): Promise<string> {
  const target = path.resolve(directory);
  await fs.mkdir(target, { recursive: true });
  if ((await fs.readdir(target)).length) throw new Error(`duet init requires an empty directory: ${target}`);

  const source = fileURLToPath(new URL("../", import.meta.url));
  const metadata = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  const dependencies = Object.fromEntries(["react", "react-dom", "zod"].map(name => [name, metadata.devDependencies[name]]));
  const devDependencies = Object.fromEntries([
    "typescript", "vite", "@vitejs/plugin-react", "tailwindcss", "@tailwindcss/vite",
    "@types/node", "@types/react", "@types/react-dom",
  ].map(name => [name, metadata.devDependencies[name]]));
  const name = path.basename(target).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "duet-app";
  const version = "0.1.0";
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(path.join(target, "package.json"), json({
    name, version, private: true, type: "module",
    scripts: {
      dev: "duet dev", build: "duet build", start: "node dist/template/main.js",
      typecheck: "duet generate && tsc --noEmit && tsc -p template/ui/tsconfig.json",
    },
    dependencies: { "duet-mcp": `^${metadata.version}`, ...dependencies }, devDependencies,
  }), {flag: "wx"});
  await fs.writeFile(path.join(target, "tsconfig.json"), json({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx",
      rootDir: ".", outDir: "dist", strict: true, skipLibCheck: true, types: ["node"],
    },
    include: ["template/*.ts", "template/duet/*.ts"],
  }), {flag: "wx"});
  await fs.writeFile(path.join(target, ".gitignore"), "node_modules/\ndist/\ndata/\n.duet/\ntemplate/duet/\n*.tgz\n", {flag: "wx"});
  await fs.copyFile(path.join(source, "duet.config.ts"), path.join(target, "duet.config.ts"), fs.constants.COPYFILE_EXCL);
  // Copy source files only, even when invoked from a built development checkout.
  for (const subdir of ["", "ui"]) {
    const from = path.join(source, "template", subdir);
    const to = path.join(target, "template", subdir);
    await fs.mkdir(to, {recursive: true});
    for (const entry of await fs.readdir(from, {withFileTypes: true})) {
      if (entry.isFile() && /\.(ts|tsx|json|html|css)$/.test(entry.name)) {
        await fs.copyFile(path.join(from, entry.name), path.join(to, entry.name), fs.constants.COPYFILE_EXCL);
      }
    }
  }
  // Separate projects should not all rendezvous on the template's app ID.
  const appFile = path.join(target, "template/app.ts");
  const app = await fs.readFile(appFile, "utf8");
  await fs.writeFile(appFile, app
    .replaceAll('id: "template"', `id: ${JSON.stringify(name)}`)
    .replace(/^  version: "[^"]*",$/m, `  version: ${JSON.stringify(version)},`));
  return target;
}
