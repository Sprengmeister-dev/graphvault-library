import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "src");
const maxLines = 1000;
const files = [];

await collectTypeScriptFiles(sourceRoot);

for (const file of files) {
  const content = await readFile(file, "utf8");
  const implementationLines = countImplementationLines(content);
  if (implementationLines > maxLines) {
    throw new Error(`${relative(root, file)} has ${implementationLines} implementation lines; limit is ${maxLines}. Split it into smaller modules.`);
  }
}

await checkPublicApiTsDoc(join(sourceRoot, "index.ts"));
await checkExportedDeclarationsTsDoc();

console.log(`Source quality check passed for ${files.length} TypeScript files, including public API and member TSDoc.`);

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

async function checkPublicApiTsDoc(indexFile) {
  const lines = (await readFile(indexFile, "utf8")).split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith("export ")) {
      continue;
    }
    let cursor = index - 1;
    while (cursor >= 0 && lines[cursor].trim() === "") {
      cursor--;
    }
    if (cursor >= 0 && isSingleLineTsDoc(lines[cursor].trim())) {
      continue;
    }
    if (cursor < 0 || lines[cursor].trim() !== "*/") {
      throw new Error(`src/index.ts:${index + 1} public export is missing a TSDoc block.`);
    }
    let sawStart = false;
    for (; cursor >= 0; cursor--) {
      const trimmed = lines[cursor].trim();
      if (trimmed === "/**") {
        sawStart = true;
        break;
      }
      if (!trimmed.startsWith("*") && trimmed !== "*/") {
        break;
      }
    }
    if (!sawStart) {
      throw new Error(`src/index.ts:${index + 1} public export has a malformed TSDoc block.`);
    }
  }
}

async function checkExportedDeclarationsTsDoc() {
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n");
    let inExportedType = false;
    let exportedDepth = 0;
    let exportedKind = "";
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const trimmed = line.trim();
      const depthBeforeLine = exportedDepth;
      if (isExportedDeclaration(trimmed)) {
        assertTsDoc(lines, index, file, "exported declaration");
      }
      if (inExportedType && depthBeforeLine === 1 && isPublicMember(line, exportedKind)) {
        assertTsDoc(lines, index, file, "public member");
      }
      if (/^export (class|interface)\b/.test(trimmed)) {
        inExportedType = true;
        exportedDepth = 0;
        exportedKind = trimmed.startsWith("export class") ? "class" : "interface";
      }
      if (inExportedType) {
        exportedDepth += count(line, "{") - count(line, "}");
        if (exportedDepth <= 0 && depthBeforeLine > 0) {
          inExportedType = false;
          exportedKind = "";
        }
      }
    }
  }
}

function isExportedDeclaration(trimmed) {
  return /^export (class|interface|function)\b/.test(trimmed);
}

function isPublicMember(line, exportedKind) {
  const trimmed = line.trim();
  if (!line.startsWith("  ") || line.startsWith("    ")) return false;
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
  if (/^(private|protected)\b/.test(trimmed)) return false;
  if (/^(if|for|while|switch|catch|return|const|let|throw|await|try)\b/.test(trimmed)) return false;
  if (trimmed.includes("=>") || trimmed === "}") return false;
  if (trimmed.startsWith("constructor")) return true;
  if (/^(?:async\s+)?(?:static\s+)?(?:get\s+)?[A-Za-z_$][\w$]*\s*[<(]/.test(trimmed)) return true;
  return exportedKind === "interface" && /^[A-Za-z_$][\w$]*\([^)]*\)\s*:/.test(trimmed);
}

function assertTsDoc(lines, index, file, label) {
  let cursor = index - 1;
  while (cursor >= 0 && lines[cursor].trim() === "") {
    cursor--;
  }
  if (cursor >= 0 && isSingleLineTsDoc(lines[cursor].trim())) {
    return;
  }
  if (cursor < 0 || lines[cursor].trim() !== "*/") {
    throw new Error(`${relative(root, file)}:${index + 1} ${label} is missing a TSDoc block.`);
  }
  for (; cursor >= 0; cursor--) {
    const trimmed = lines[cursor].trim();
    if (trimmed === "/**") {
      return;
    }
    if (!trimmed.startsWith("*") && trimmed !== "*/") {
      break;
    }
  }
  throw new Error(`${relative(root, file)}:${index + 1} ${label} has a malformed TSDoc block.`);
}

function count(value, needle) {
  return value.split(needle).length - 1;
}

function isSingleLineTsDoc(trimmed) {
  return trimmed.startsWith("/**") && trimmed.endsWith("*/");
}

function countImplementationLines(content) {
  let inTsDoc = false;
  let count = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("/**")) {
      inTsDoc = !trimmed.endsWith("*/");
      continue;
    }
    if (inTsDoc) {
      if (trimmed.endsWith("*/")) {
        inTsDoc = false;
      }
      continue;
    }
    count++;
  }
  return count;
}
