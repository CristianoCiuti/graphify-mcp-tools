import type { CommandModule } from "yargs";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { loadConfig } from "../core/config.js";
import { resolveGraphPath } from "../core/graph-resolver.js";
import { log } from "../shared/utils.js";
import { getOutliner } from "../outline/languages/index.js";
import type { FileOutline } from "../shared/types.js";

export const outlineCommand: CommandModule = {
  command: "outline",
  describe: "Pre-compute outlines for configured file patterns",
  builder: (yargs) =>
    yargs
      .option("config", {
        type: "string",
        describe: "Path to graphify-tools.config.yml",
      })
      .option("force", {
        type: "boolean",
        describe: "Regenerate all outlines",
        default: false,
      }),
  handler: async (argv) => {
    const { config, configDir } = loadConfig(argv.config as string | undefined);

    if (!config.outlines.enabled) {
      log.info("Outlines are disabled in config");
      return;
    }

    const graphDir = resolveGraphPath(argv.graph as string | undefined) ?? join(configDir, config.output);
    const outlinesDir = join(graphDir, "outlines");

    if (!existsSync(outlinesDir)) {
      mkdirSync(outlinesDir, { recursive: true });
    }

    log.info(`Generating outlines in ${outlinesDir}...`);

    // Resolve language outliner (regex fallback)
    const language = config.outlines.language ?? "python";
    const regexOutliner = getOutliner(language);

    // Try tree-sitter first, fall back to regex
    let useTreeSitter = false;
    let parser: Awaited<ReturnType<typeof import("../outline/parser.js")["initParser"]>> | null = null;
    try {
      const { initParser } = await import("../outline/parser.js");
      parser = await initParser();
      useTreeSitter = true;
      log.info("Using tree-sitter parser");
    } catch {
      if (regexOutliner) {
        log.info(`Tree-sitter unavailable, using regex-based outline generation (${language})`);
      } else {
        log.error(`Tree-sitter unavailable and no regex outliner for language: ${language}`);
        return;
      }
    }

    const { formatOutlineJson } = await import("../outline/formatter.js");

    let count = 0;

    // Process configured repos
    for (const repo of config.repos) {
      const repoPath = resolve(configDir, repo.path);
      if (!existsSync(repoPath)) {
        log.warn(`Repo path not found: ${repoPath}`);
        continue;
      }

      for (const pattern of config.outlines.paths) {
        const files = findFiles(repoPath, pattern, config.outlines.exclude);

        for (const file of files) {
          const relPath = `${repo.name}/${relative(repoPath, file)}`.split("\\").join("/");
          const outPath = join(outlinesDir, relPath + ".outline.json");

          if (!argv.force && existsSync(outPath)) continue;

          try {
            const source = readFileSync(file, "utf-8");
            const lineCount = source.split("\n").length;
            let outline: FileOutline;

            if (useTreeSitter && parser) {
              const { extractOutline } = await import("../outline/extractor.js");
              const { parseSource } = await import("../outline/parser.js");
              const rootNode = parseSource(parser, source);
              outline = extractOutline(rootNode, relPath, lineCount);
            } else {
              outline = regexOutliner!(relPath, source, lineCount);
            }

            const outDir = dirname(outPath);
            if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

            writeFileSync(outPath, formatOutlineJson(outline));
            count++;
          } catch (error) {
            log.warn(`Failed to process ${file}: ${error}`);
          }
        }
      }
    }

    log.info(`Generated ${count} outlines`);
  },
};

/**
 * Recursive file finder that respects glob-like include patterns.
 * Supports patterns like "lib/jobs/[star][star]/[star].py", "commonlib/[star][star]/[star].py", etc.
 */
function findFiles(baseDir: string, pattern: string, exclude: string[]): string[] {
  const results: string[] = [];
  const ext = pattern.includes("*.py") ? ".py" : pattern.split("*").pop() ?? "";

  // Extract the prefix directory from the pattern (before the first **)
  // e.g. "lib/jobs/**/*.py" → "lib/jobs"
  const prefixMatch = pattern.match(/^([^*]*?)(?:\/?\*\*)/);
  const prefixDir = prefixMatch?.[1] || "";

  // Determine the start directory for walking
  const startDir = prefixDir ? join(baseDir, prefixDir) : baseDir;
  if (!existsSync(startDir)) return results;

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath).split("\\").join("/");

      // Check exclusions
      if (exclude.some((ex) => matchPattern(relPath, ex))) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(ext)) {
        // Verify the file matches the include pattern
        if (matchIncludePattern(relPath, pattern)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(startDir);
  return results;
}

/**
 * Check if a relative path matches an include glob pattern.
 */
function matchIncludePattern(relPath: string, pattern: string): boolean {
  // Convert glob pattern to a simple regex
  // "lib/jobs/**/*.py" → must start with "lib/jobs/" and end with ".py"
  const prefixMatch = pattern.match(/^([^*]*?)(?:\/?\*\*\/?\*?)/);
  const prefix = prefixMatch?.[1] || "";
  const ext = pattern.includes("*.") ? "." + pattern.split("*.").pop()! : "";

  if (prefix && !relPath.startsWith(prefix)) return false;
  if (ext && !relPath.endsWith(ext)) return false;
  return true;
}

function matchPattern(path: string, pattern: string): boolean {
  // Simple glob matching for exclusion patterns
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return path.includes(suffix);
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path.startsWith(prefix);
  }
  return path.includes(pattern.replace(/\*\*/g, "").replace(/\*/g, ""));
}
