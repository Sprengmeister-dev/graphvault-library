import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "src");
const maxLines = 1000;
const files = [];

await collectTypeScriptFiles(sourceRoot);

for (const file of files) {
  const content = await readFile(file, "utf8");
  const lines = content.split("\n").length;
  if (lines > maxLines) {
    throw new Error(`${relative(root, file)} has ${lines} lines; limit is ${maxLines}. Split it into smaller modules.`);
  }
}

console.log(`Source quality check passed for ${files.length} TypeScript files.`);

async function collectTypeScriptFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTypeScriptFiles(path);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
}
