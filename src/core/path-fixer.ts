/**
 * Normalize file paths from absolute to relative with forward slashes.
 * Used during indexing to ensure consistent paths in the database.
 */
export function fixPaths(filePath: string, basePaths: string[]): string {
  // Normalize all backslashes to forward slashes upfront (platform-agnostic)
  let normalized = filePath.replace(/\\/g, "/");

  // Try stripping each base path prefix
  for (const base of basePaths) {
    const normalizedBase = base.replace(/\\/g, "/").replace(/\/$/, "") + "/";
    if (normalized.startsWith(normalizedBase)) {
      normalized = normalized.slice(normalizedBase.length);
      break;
    }
  }

  // Remove leading ./
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

/**
 * Apply path fixing to all nodes in graph data (mutates in place).
 */
export function fixGraphPaths(
  nodes: Array<{ source_file?: string }>,
  basePaths: string[],
): void {
  for (const node of nodes) {
    if (node.source_file) {
      node.source_file = fixPaths(node.source_file, basePaths);
    }
  }
}
