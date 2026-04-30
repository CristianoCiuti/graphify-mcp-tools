import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import type { Config, GraphData } from "../shared/types.js";
import { checkGraphify } from "./graphify-check.js";
import { runIndexer } from "./indexer.js";
import { runOutlineGeneration } from "./outlines.js";
import { postProcess } from "./post-process.js";
import { log } from "../shared/utils.js";

/** Env vars for all Python subprocesses (Windows cp1252 fails on graphify Unicode output) */
const PYTHON_ENV = { ...process.env, PYTHONIOENCODING: "utf-8" };

export interface BuildOptions {
  force: boolean;
}

interface GraphifyInfo {
  version: string;
  command: string;
}

/**
 * Python script template for initial graph build via graphify library API.
 * Uses: detect → extract → build_from_json → cluster → to_json
 *
 * Key design decisions:
 * - Uses detect() instead of collect_files() because detect() applies
 *   _SKIP_DIRS filtering (venv/, node_modules/, site-packages/, etc.)
 * - Uses forward slashes for paths (Python's Path handles both on Windows).
 * - Monkey-patches _SKIP_DIRS with user-configured exclusions before detect().
 */
function buildPythonScript(repoPath: string, outPath: string, excludeDirs: string[]): string {
  const pyRepoPath = repoPath.replace(/\\/g, "/");
  const pyOutPath = outPath.replace(/\\/g, "/");

  const excludeBlock = excludeDirs.length > 0
    ? `\nfrom graphify.detect import _SKIP_DIRS\nfor d in ${JSON.stringify(excludeDirs)}:\n    _SKIP_DIRS.add(d)\n`
    : "";

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
${excludeBlock}
path = Path("${pyRepoPath}")
out = Path("${pyOutPath}")
out.mkdir(parents=True, exist_ok=True)

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
 * Run the full build pipeline.
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
    log.error("No repos configured. Add repos to graphify-mcp-tools.yml");
    process.exit(1);
  }

  // Create output directory (with --force cleanup)
  const outputDir = resolve(configDir, config.output);

  if (options.force) {
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
      log.info(`Cleaned output: ${outputDir}`);
    }
    for (const repo of config.repos) {
      const repoCache = resolve(configDir, repo.path, "graphify-out", "cache");
      if (existsSync(repoCache)) {
        rmSync(repoCache, { recursive: true, force: true });
        log.info(`Cleaned cache: ${repoCache}`);
      }
    }
  }

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const tmpDir = join(tmpdir(), `graphify-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // 2. Build graph
    const mergedPath = join(outputDir, "graph.json");
    const mode = config.build.mode;
    log.info(`Build mode: ${mode}`);

    let postProcessBasePaths: string[];

    if (mode === "monorepo") {
      const workspace = join(tmpDir, "workspace");
      await buildMonorepo(config, configDir, options, graphifyInfo, tmpDir, mergedPath, workspace);
      // In monorepo mode, source_file paths start with workspace prefix
      postProcessBasePaths = [workspace];
    } else {
      await buildSeparate(config, configDir, options, graphifyInfo, tmpDir, outputDir, mergedPath);
      postProcessBasePaths = config.repos.map((r) => resolve(configDir, r.path));
    }

    // 3. Post-process paths
    postProcess(mergedPath, postProcessBasePaths);

    // 3b. Tag nodes with repo name (monorepo: from first path component after normalization)
    if (mode === "monorepo") {
      const repoNames = config.repos.map((r) => r.name);
      tagNodesWithRepo(mergedPath, repoNames);
    }

    // 4. Post-build analysis (report + HTML visualization)
    runPostBuildAnalysis(mergedPath, outputDir, config, tmpDir);

    // 5. Generate search index
    await runIndexer(mergedPath, outputDir);

    // 6. Generate outlines (if enabled)
    if (config.outlines.enabled) {
      log.info("Generating outlines...");
      const outlineCount = await runOutlineGeneration(config, configDir, outputDir, { force: options.force });
      log.info(`  ✓ ${outlineCount} outlines generated`);
    }

    log.info("");
    log.info("Build complete!");
    log.info(`  Output: ${outputDir}`);
    log.info(`  Repos: ${config.repos.length}`);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ─── Monorepo mode ───────────────────────────────────────────────────────────

/**
 * Monorepo build: symlink all repos into a single temp workspace, run ONE
 * graphify build so cross-repo imports are resolved in a single extraction batch.
 *
 * 1. Create tmp workspace with symlinks/junctions for each repo
 * 2. Run `graphify update <workspace>` (or full Python API build)
 * 3. Copy graph.json to output, tag nodes with repo name
 */
async function buildMonorepo(
  config: Config,
  configDir: string,
  options: BuildOptions,
  graphifyInfo: GraphifyInfo,
  tmpDir: string,
  mergedPath: string,
  workspace: string,
): Promise<void> {
  mkdirSync(workspace, { recursive: true });

  // Symlink each repo into workspace/<repo_name>
  const repoNames: string[] = [];
  for (const repo of config.repos) {
    const repoPath = resolve(configDir, repo.path);
    if (!existsSync(repoPath)) {
      log.warn(`Repo not found, skipping: ${repoPath}`);
      continue;
    }

    const linkPath = join(workspace, repo.name);
    try {
      // Windows: use 'junction' (no admin privileges needed)
      // Unix: use 'dir' symlink
      symlinkSync(repoPath, linkPath, "junction");
      log.info(`  Linked: ${repo.name} → ${repoPath}`);
      repoNames.push(repo.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`  Symlink failed for ${repo.name}: ${msg}, falling back to copy...`);
      copyDirRecursive(repoPath, linkPath, config.build.exclude);
      repoNames.push(repo.name);
    }
  }

  if (repoNames.length === 0) {
    log.error("No repos linked. Check repo paths.");
    process.exit(1);
  }

  // Build: single extraction batch over the whole workspace
  const workspaceGraphOut = join(workspace, "graphify-out");
  const existingGraph = join(workspaceGraphOut, "graph.json");
  const useUpdate = !options.force && existsSync(existingGraph);

  log.info(`Building unified graph (${repoNames.length} repos)...`);

  if (useUpdate) {
    const updateCmd = `${graphifyInfo.command} update "${workspace}"`;
    log.debug(`  Incremental: ${updateCmd}`);
    execSync(updateCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 600_000, env: PYTHON_ENV });
  } else {
    const script = buildPythonScript(workspace, workspaceGraphOut, config.build.exclude);
    const scriptPath = join(tmpDir, "monorepo_build.py");
    writeFileSync(scriptPath, script);
    log.debug(`  Full build via Python API (${scriptPath})`);
    const output = execSync(`python "${scriptPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 600_000,
      cwd: workspace,
      env: PYTHON_ENV,
    });
    if (output.trim()) log.info(`  ${output.trim()}`);
  }

  const builtGraph = join(workspaceGraphOut, "graph.json");
  if (!existsSync(builtGraph)) {
    log.error("graph.json not produced by monorepo build.");
    process.exit(1);
  }

  // Copy to output and tag nodes with repo name
  copyFileSync(builtGraph, mergedPath);
  // NOTE: tagging happens after postProcess normalizes paths (called by runBuild)
  log.info(`✓ Unified graph: ${mergedPath}`);
}

/**
 * Tag each node's `repo` field based on the first path component of source_file.
 * e.g. source_file="motore_common/src/foo.py" → repo="motore_common"
 */
function tagNodesWithRepo(graphJsonPath: string, repoNames: string[]): void {
  const raw = readFileSync(graphJsonPath, "utf-8");
  const data = JSON.parse(raw) as GraphData;
  const repoSet = new Set(repoNames);

  for (const node of data.nodes) {
    if (!node.source_file) continue;
    const normalized = node.source_file.replace(/\\/g, "/");
    const firstComponent = normalized.split("/")[0];
    if (firstComponent && repoSet.has(firstComponent)) {
      node.repo = firstComponent;
    }
  }

  writeFileSync(graphJsonPath, JSON.stringify(data, null, 2));
}

/**
 * Recursive directory copy with exclusion support.
 * Fallback for when symlinks/junctions fail.
 */
function copyDirRecursive(src: string, dest: string, excludeDirs: string[]): void {
  const excludeSet = new Set(excludeDirs);
  mkdirSync(dest, { recursive: true });

  for (const entry of readdirSync(src)) {
    if (excludeSet.has(entry)) continue;
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath, excludeDirs);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Separate mode (original: per-repo build + merge) ───────────────────────

async function buildSeparate(
  config: Config,
  configDir: string,
  options: BuildOptions,
  graphifyInfo: GraphifyInfo,
  tmpDir: string,
  outputDir: string,
  mergedPath: string,
): Promise<void> {
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

    const existingGraph = join(repoPath, "graphify-out", "graph.json");
    const useUpdate = !options.force && existsSync(existingGraph);

    try {
      if (useUpdate) {
        const updateCmd = `${graphifyInfo.command} update "${repoPath}"`;
        log.debug(`  Incremental: ${updateCmd}`);
        execSync(updateCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 600_000, env: PYTHON_ENV });
        copyFileSync(existingGraph, join(repoOutDir, "graph.json"));
      } else {
        const script = buildPythonScript(repoPath, repoOutDir, config.build.exclude);
        const scriptPath = join(tmpDir, `${repo.name}_build.py`);
        writeFileSync(scriptPath, script);
        log.debug(`  Initial build via Python API (${scriptPath})`);
        const output = execSync(`python "${scriptPath}"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 600_000,
          cwd: repoPath,
          env: PYTHON_ENV,
        });
        if (output.trim()) log.info(`  ${output.trim()}`);
      }

      const graphJson = join(repoOutDir, "graph.json");
      if (existsSync(graphJson)) {
        repoGraphs.push(graphJson);
        log.info(`  ✓ ${repo.name}`);
      } else {
        log.error(`  ✗ ${repo.name}: graph.json not produced`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`  ✗ ${repo.name}: ${msg}`);
    }
  }

  if (repoGraphs.length === 0) {
    log.error("No graphs were generated. Check repo paths and graphify installation.");
    process.exit(1);
  }

  // Merge via `graphify merge-graphs`
  if (repoGraphs.length > 1) {
    const filesArg = repoGraphs.map((f) => `"${f}"`).join(" ");
    const mergeCmd = `${graphifyInfo.command} merge-graphs ${filesArg} --out "${mergedPath}"`;
    log.info("Merging graphs...");
    execSync(mergeCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: PYTHON_ENV });
  } else {
    copyFileSync(repoGraphs[0]!, mergedPath);
  }
  log.info(`✓ Merged graph: ${mergedPath}`);
}

// ─── Post-build analysis ─────────────────────────────────────────────────────

/**
 * Generate GRAPH_REPORT.md and optionally graph.html.
 */
function runPostBuildAnalysis(mergedPath: string, outputDir: string, config: Config, tmpDir: string): void {
  const pyMergedPath = mergedPath.replace(/\\/g, "/");
  const pyOutputDir = outputDir.replace(/\\/g, "/");
  const htmlEnabled = config.build.html;
  const htmlMinDegree = config.build.html_min_degree;
  const htmlCommunityFallback = config.build.html_community_fallback;

  let htmlBlock = "";
  if (htmlEnabled) {
    // Build the HTML generation block with fallback logic
    const NODE_LIMIT = 5000;
    let vizCode: string;

    if (htmlMinDegree != null) {
      // Filter by degree first, then check limit
      vizCode = `
# HTML visualization
from graphify.export import to_html
from collections import Counter

threshold = ${htmlMinDegree}
subgraph_nodes = [n for n in G.nodes() if G.degree(n) >= threshold]
H = G.subgraph(subgraph_nodes).copy()
sub_communities = {}
node_set = set(H.nodes())
for cid, members in communities.items():
    filtered = [m for m in members if m in node_set]
    if filtered:
        sub_communities[cid] = filtered

if H.number_of_nodes() <= ${NODE_LIMIT}:
    to_html(H, sub_communities, str(out / "graph.html"), community_labels=labels or None)
    print(f"  graph.html written ({H.number_of_nodes()} nodes, degree >= {threshold})")
elif ${htmlCommunityFallback ? "True" : "False"}:
    # Aggregated community view
    node_to_community = {nid: cid for cid, members in sub_communities.items() for nid in members}
    import networkx as nx_meta
    meta = nx_meta.Graph()
    for cid, members in sub_communities.items():
        meta.add_node(str(cid), label=labels.get(cid, f"Community {cid}"))
    edge_counts = Counter()
    for u, v in H.edges():
        cu, cv = node_to_community.get(u), node_to_community.get(v)
        if cu is not None and cv is not None and cu != cv:
            edge_counts[(min(cu, cv), max(cu, cv))] += 1
    for (cu, cv), w in edge_counts.items():
        meta.add_edge(str(cu), str(cv), weight=w, relation=f"{w} cross-community edges", confidence="AGGREGATED")
    if meta.number_of_nodes() > 1:
        meta_communities = {cid: [str(cid)] for cid in sub_communities}
        member_counts = {cid: len(members) for cid, members in sub_communities.items()}
        to_html(meta, meta_communities, str(out / "graph.html"), community_labels=labels or None, member_counts=member_counts)
        print(f"  graph.html written (aggregated: {meta.number_of_nodes()} community nodes)")
    else:
        print("  graph.html skipped (single community after filtering)")
else:
    print(f"  graph.html skipped ({H.number_of_nodes()} nodes exceeds limit)")
`;
    } else {
      // No degree filter
      vizCode = `
# HTML visualization
from graphify.export import to_html
from collections import Counter

if G.number_of_nodes() <= ${NODE_LIMIT}:
    to_html(G, communities, str(out / "graph.html"), community_labels=labels or None)
    print(f"  graph.html written ({G.number_of_nodes()} nodes)")
elif ${htmlCommunityFallback ? "True" : "False"}:
    # Aggregated community view: each node = 1 community
    node_to_community = {nid: cid for cid, members in communities.items() for nid in members}
    import networkx as nx_meta
    meta = nx_meta.Graph()
    for cid, members in communities.items():
        meta.add_node(str(cid), label=labels.get(cid, f"Community {cid}"))
    edge_counts = Counter()
    for u, v in G.edges():
        cu, cv = node_to_community.get(u), node_to_community.get(v)
        if cu is not None and cv is not None and cu != cv:
            edge_counts[(min(cu, cv), max(cu, cv))] += 1
    for (cu, cv), w in edge_counts.items():
        meta.add_edge(str(cu), str(cv), weight=w, relation=f"{w} cross-community edges", confidence="AGGREGATED")
    if meta.number_of_nodes() > 1:
        meta_communities = {cid: [str(cid)] for cid in communities}
        member_counts = {cid: len(members) for cid, members in communities.items()}
        to_html(meta, meta_communities, str(out / "graph.html"), community_labels=labels or None, member_counts=member_counts)
        print(f"  graph.html written (aggregated: {meta.number_of_nodes()} community nodes)")
    else:
        print("  graph.html skipped (single community)")
else:
    print(f"  graph.html skipped ({G.number_of_nodes()} nodes exceeds limit)")
`;
    }
    htmlBlock = vizCode;
  }

  const script = `
import sys, json
from pathlib import Path

try:
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes, surprising_connections, suggest_questions
    from graphify.report import generate as generate_report
    from graphify.build import build_from_json
    import networkx as nx
except ImportError as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)

graph_path = Path("${pyMergedPath}")
out = Path("${pyOutputDir}")

# Load graph.json into networkx
with open(graph_path) as f:
    data = json.load(f)

G = nx.DiGraph()
for node in data.get("nodes", []):
    G.add_node(node["id"], **{k: v for k, v in node.items() if k != "id"})
for edge in data.get("edges", data.get("links", [])):
    G.add_edge(edge["source"], edge["target"], **{k: v for k, v in edge.items() if k not in ("source", "target")})

# Cluster and analyze
communities = cluster(G)
scores = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: f"Community {cid}" for cid in communities}
questions = suggest_questions(G, communities, labels)

# Generate report (always)
file_nodes = [n for n, d in G.nodes(data=True) if d.get("type") == "file"]
detection_result = {"total_files": len(file_nodes), "total_words": G.number_of_nodes() * 50}
token_cost = {"input": 0, "output": 0}

report_md = generate_report(
    G, communities, scores, labels, gods, surprises,
    detection_result, token_cost, ".", questions
)
(out / "GRAPH_REPORT.md").write_text(report_md, encoding="utf-8")
print(f"  GRAPH_REPORT.md written")
${htmlBlock}
`.trim();

  const scriptPath = join(tmpDir, "post_build_analysis.py");
  writeFileSync(scriptPath, script);

  log.info("Running post-build analysis...");
  try {
    const output = execSync(`python "${scriptPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
      env: PYTHON_ENV,
    });
    if (output.trim()) {
      for (const line of output.trim().split("\n")) {
        log.info(line);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`Post-build analysis failed (non-fatal): ${msg}`);
  }
}
