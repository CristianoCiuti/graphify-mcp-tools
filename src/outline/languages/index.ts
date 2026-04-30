/**
 * Language-specific outline generators registry.
 *
 * Each language module exports a function that produces a FileOutline
 * from source code using regex-based parsing (no external dependencies).
 *
 * Usage:
 *   import { getOutliner } from "../outline/languages/index.js";
 *   const outliner = getOutliner("python");
 *   if (outliner) {
 *     const outline = outliner(filePath, source, lineCount);
 *   }
 */
import type { FileOutline } from "../../shared/types.js";
import { pythonOutliner } from "./python.js";

/**
 * Signature for a regex-based outline generator.
 * Each language implements this contract.
 */
export type OutlinerFn = (filePath: string, source: string, lineCount: number) => FileOutline;

/** Supported language → outliner mapping */
const registry: Record<string, OutlinerFn> = {
  python: pythonOutliner,
  // Future: java, typescript, scala, etc.
};

/**
 * Get the regex-based outline generator for a given language.
 * Returns null if the language is not supported.
 */
export function getOutliner(language: string): OutlinerFn | null {
  return registry[language.toLowerCase()] ?? null;
}

/**
 * List all supported languages.
 */
export function supportedLanguages(): string[] {
  return Object.keys(registry);
}
