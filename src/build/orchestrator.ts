import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../shared/types.js";
import { checkGraphify } from "./graphify-check.js";
import { runIndexer } from "./indexer.js";
import { postProcess } from "./post-process.js";
import { log } from "../shared/utils.js";

export interface BuildOptions {
  force: boolean;
}

/**
 * Python script template for initial graph build via graphify library API.
 * Uses: detect → extract → build_from_json → cluster → to_json
 * This is AST-only (deterministic, no LLM cost).
 *
 * Key design decisions:
 * - Uses detect() instead of collect_files() because detect() applies
 *   _SKIP_DIRS filtering (venv/, node_modules/, site-packages/, etc.)
 *   while collect_files() does not, causing RecursionError on repos
 *   with virtualenvs containing deeply-nested C files.
 * - Uses forward slashes for paths (Python's Path handles both on Windows).
 */
function buildPythonScript(repoPath: string, outPath: string): string {
  // Use forward slashes — Python Path handles them correctly on all platforms.
  // Backslash escaping through shell layers is error-prone on Windows.
  const pyRepoPath = repoPath.replace(/\\/g, "/");
  const pyOutPath = outPath.replace(/\\/g, "/");

  return `
import sys, json
from pathlib import Path

try:
    from graphify.detect import detect
    from graphify.extract import extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json
except ImportError:
    print("ERROR: graphify not importable", file=sys.stderr)
    sys.exit(1)

path = Path("${pyRepoPath}")
out = Path("${pyOutPath}")
out.mkdir(parents=True, exist_ok=True)

# Use detect() for proper filtering (skips venv/, node_modules/, site-packages/, etc.)
result = detect(path)
code_files = [Path(f) for f in result.get("files", {}).get("code", [])]

if not code_files:
    (out / "graph.json").write_text(json.dumps({"nodes": [], "links": []}))
    print("0 nodes, 0 edges (no code files found)")
    sys.exit(0)

extraction = extract(code_files, cache_root=path)
G = build_from_json(extraction)
communities = cluster(G)
to_json(G, communities, str(out / "graph.json"))
print(f"{G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(communities)} communities")
`.trim();
}

/**
 * Run the full build pipeline:
 * 1. Verify graphify installed (PyPI: graphifyy)
 * 2. For each repo: run Python API build (or `graphify update` for incremental)
 * 3. Merge graphs via `graphify merge-graphs`
 * 4. Post-process paths
 * 5. Generate search index
 */
export async function runBuild(config: Config, configDir: string, options: BuildOptions): Promise<void> {
  // 1. Verify graphify
  const graphifyInfo = checkGraphify();
  if (!graphifyInfo) {
    log.error("graphify (PyPI: graphifyy) is required for building the knowledge graph.");
    log.error("Install: pip install graphifyy   (or: uv tool install graphifyy)");
    process.exit(1);
  }

  log.info(`Using graphify: v${graphifyInfo.version}`);

  if (config.repos.length === 0) {
    log.error("No repos configured. Add repos to graphify-tools.config.yml");
    process.exit(1);
  }

  // Create output directory
  const outputDir = resolve(configDir, config.output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Create temp directory for individual repo graphs
  const tmpDir = join(tmpdir(), `graphify-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // 2. Build each repo
    const repoGraphs: string[] = [];
    for (const repo of config.repos) {
      const repoPath = resolve(configDir, repo.path);
      if (!existsSync(repoPath)) {
        log.warn(`Repo not found, skipping: ${repoPath}`);
        continue;
      }

      const repoOutDir = join(tmpDir, repo.name);
      mkdirSync(repoOutDir, { recursive: true });

      log.info(`Building graph for ${repo.name}...`);

      // Check if repo has existing graph (use `graphify update` for incremental)
      const existingGraph = join(repoPath, "graphify-out", "graph.json");
      const useUpdate = !options.force && existsSync(existingGraph);

      try {
        if (useUpdate) {
          // Incremental: use `graphify update <path>` (re-extracts code, no LLM)
          const updateCmd = `${graphifyInfo.command} update "${repoPath}"`;
          log.debug(`  Incremental: ${updateCmd}`);
          execSync(updateCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 600_000 });
          // Copy the updated graph to our temp dir
          copyFileSync(existingGraph, join(repoOutDir, "graph.json"));
        } else {
          // Initial build: write Python script to temp file and execute.
          // This avoids quoting/escaping issues with `python -c "..."` on Windows.
          const script = buildPythonScript(repoPath, repoOutDir);
          const scriptPath = join(tmpDir, `${repo.name}_build.py`);
          writeFileSync(scriptPath, script);
          log.debug(`  Initial build via Python API (${scriptPath})`);
          const output = execSync(`python "${scriptPath}"`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 600_000,
            cwd: repoPath,
          });
          if (output.trim()) log.info(`  ${output.trim()}`);
        }

        const graphJson = join(repoOutDir, "graph.json");
        if (existsSync(graphJson)) {
          repoGraphs.push(graphJson);
          log.info(`  \u2713 ${repo.name}`);
        } else {
          log.error(`  \u2717 ${repo.name}: graph.json not produced`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`  \u2717 ${repo.name}: ${msg}`);
      }
    }

    if (repoGraphs.length === 0) {
      log.error("No graphs were generated. Check repo paths and graphify installation.");
      process.exit(1);
    }

    // 3. Merge graphs via `graphify merge-graphs`
    const mergedPath = join(outputDir, "graph.json");
    if (repoGraphs.length > 1) {
      const filesArg = repoGraphs.map((f) => `"${f}"`).join(" ");
      const mergeCmd = `${graphifyInfo.command} merge-graphs ${filesArg} --out "${mergedPath}"`;
      log.info("Merging graphs...");
      execSync(mergeCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } else {
      // Single repo - just copy
      copyFileSync(repoGraphs[0]!, mergedPath);
    }
    log.info(`\u2713 Merged graph: ${mergedPath}`);

    // 4. Post-process
    const basePaths = config.repos.map((r) => resolve(configDir, r.path));
    postProcess(mergedPath, basePaths);

    // 5. Generate search index
    await runIndexer(mergedPath, outputDir);

    log.info("");
    log.info("Build complete!");
    log.info(`  Output: ${outputDir}`);
    log.info(`  Repos: ${config.repos.length}`);
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
