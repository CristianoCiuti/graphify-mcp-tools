import type { Database } from "../../core/db.js";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OutlineCache } from "../../outline/cache.js";
import { formatOutlineMarkdown, formatOutlineJson } from "../../outline/formatter.js";
import { getOutliner } from "../../outline/languages/index.js";
import type { FileOutline } from "../../shared/types.js";

const outlineCache = new OutlineCache();

export function handleOutline(_db: Database, graphDir: string, args: Record<string, unknown>) {
  const filePath = args.file_path as string;
  const format = (args.format as string) ?? "markdown";
  if (!filePath) return { content: [{ type: "text" as const, text: "Error: 'file_path' is required" }], isError: true };

  const cached = outlineCache.get(filePath);
  if (cached) {
    const text = format === "json" ? formatOutlineJson(cached) : formatOutlineMarkdown(cached);
    return { content: [{ type: "text" as const, text }] };
  }

  // Check pre-computed
  const preComputed = join(graphDir, "outlines", filePath + ".outline.json");
  if (existsSync(preComputed)) {
    try {
      const outline = JSON.parse(readFileSync(preComputed, "utf-8")) as FileOutline;
      outlineCache.set(filePath, outline);
      const text = format === "json" ? formatOutlineJson(outline) : formatOutlineMarkdown(outline);
      return { content: [{ type: "text" as const, text }] };
    } catch { /* fall through */ }
  }

  // Try source file — generate outline on-the-fly using language registry
  const workspaceRoot = resolve(graphDir, "..");
  const absolutePath = resolve(workspaceRoot, filePath);
  if (!existsSync(absolutePath)) {
    return { content: [{ type: "text" as const, text: `File not found: ${filePath}` }] };
  }

  // Detect language from file extension
  const language = detectLanguage(filePath);
  const outliner = getOutliner(language);
  if (!outliner) {
    return { content: [{ type: "text" as const, text: `No outline support for language: ${language} (${filePath})` }] };
  }

  const source = readFileSync(absolutePath, "utf-8");
  const lineCount = source.split("\n").length;
  const outline = outliner(filePath, source, lineCount);
  outlineCache.set(filePath, outline);
  const text = format === "json" ? formatOutlineJson(outline) : formatOutlineMarkdown(outline);
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Detect language from file extension.
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const extMap: Record<string, string> = {
    py: "python",
    java: "java",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    scala: "scala",
    kt: "kotlin",
  };
  return extMap[ext] ?? ext;
}
