import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "extension");
const output = path.join(root, "dist", "extension");

const entries = ["background", "bridge", "collector", "options", "overlay"];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await Promise.all(
  entries.map((entry) =>
    build({
      entryPoints: [path.join(source, "src", `${entry}.ts`)],
      outfile: path.join(output, `${entry}.js`),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome120",
      sourcemap: true,
      logLevel: "info",
    }),
  ),
);
await Promise.all(
  ["manifest.json", "options.html", "overlay.css"].map((file) =>
    cp(path.join(source, file), path.join(output, file)),
  ),
);
