/**
 * Python regex-based outline generator.
 *
 * Extracts structural information from Python source code without
 * requiring tree-sitter or any external parser. Handles:
 * - Module-level imports (import / from...import)
 * - Top-level function definitions (with decorators, docstrings, end_line)
 * - Class definitions (with bases, decorators, docstrings, methods)
 * - Method definitions inside classes (with decorators, docstrings)
 *
 * Limitations vs tree-sitter:
 * - No nested class support (only top-level classes)
 * - No call-graph extraction (calls[] always empty)
 * - end_line is heuristic-based (looks for dedent)
 * - Multi-line signatures not handled (only first line matched)
 */
import type { FileOutline, ImportEntry, FunctionEntry, ClassEntry } from "../../shared/types.js";

/**
 * Generate a structured outline from Python source code.
 */
export function pythonOutliner(filePath: string, source: string, lineCount: number): FileOutline {
  const lines = source.split("\n");
  const imports: ImportEntry[] = [];
  const functions: FunctionEntry[] = [];
  const classes: ClassEntry[] = [];

  let currentClass: ClassEntry | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    // End class on non-indented non-empty line (that's not a decorator or comment)
    if (currentClass && line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (!trimmed.startsWith("@") && !trimmed.startsWith("#")) {
        currentClass.end_line = i; // previous line (1-indexed in output)
        classes.push(currentClass);
        currentClass = null;
      }
    }

    // Imports (only at module level — no leading whitespace)
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const fromImport = /^from\s+(\S+)\s+import\s+(.+)/.exec(line);
      if (fromImport) {
        imports.push({
          module: fromImport[1]!,
          names: fromImport[2]!.split(",").map((n) => n.trim().split(" as ")[0]!.trim()),
          line: i + 1,
        });
        continue;
      }
      const plainImport = /^import\s+(.+)/.exec(line);
      if (plainImport) {
        imports.push({
          module: plainImport[1]!.split(",")[0]!.trim().split(" as ")[0]!.trim(),
          line: i + 1,
        });
        continue;
      }
    }

    // Top-level function (no indentation)
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const funcMatch = /^def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/.exec(line);
      if (funcMatch) {
        const endLine = findBlockEnd(lines, i, 0);
        functions.push({
          name: funcMatch[1]!,
          signature: buildSignature(funcMatch[1]!, funcMatch[2]!, funcMatch[3]),
          decorators: collectDecorators(lines, i),
          docstring: extractDocstring(lines, i + 1, "    "),
          start_line: i + 1,
          end_line: endLine,
          calls: [],
        });
        continue;
      }
    }

    // Class definition (no indentation)
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const classMatch = /^class\s+(\w+)(?:\(([^)]*)\))?\s*:/.exec(line);
      if (classMatch) {
        if (currentClass) {
          currentClass.end_line = i;
          classes.push(currentClass);
        }
        currentClass = {
          name: classMatch[1]!,
          bases: classMatch[2] ? classMatch[2].split(",").map((b) => b.trim()) : [],
          docstring: extractDocstring(lines, i + 1, "    "),
          start_line: i + 1,
          end_line: lineCount,
          methods: [],
        };
        continue;
      }
    }

    // Method inside current class (indented def, typically 4 spaces)
    if (currentClass) {
      const methodMatch = /^(\s{4}|\t)def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/.exec(line);
      if (methodMatch) {
        const indent = methodMatch[1]!.length;
        const endLine = findBlockEnd(lines, i, indent);
        currentClass.methods.push({
          name: methodMatch[2]!,
          signature: buildSignature(methodMatch[2]!, methodMatch[3]!, methodMatch[4]),
          decorators: collectDecorators(lines, i),
          docstring: extractDocstring(lines, i + 1, " ".repeat(indent + 4)),
          start_line: i + 1,
          end_line: endLine,
          calls: [],
        });
      }
    }
  }

  // Close any open class at end of file
  if (currentClass) {
    currentClass.end_line = lineCount;
    classes.push(currentClass);
  }

  return { file_path: filePath, line_count: lineCount, imports, functions, classes };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildSignature(name: string, params: string, returnType: string | undefined): string {
  return `${name}(${params})${returnType ? ` -> ${returnType}` : ""}`;
}

/**
 * Collect decorator lines above a definition.
 * Walks backwards from defLineIdx, skipping blanks and comments.
 */
function collectDecorators(lines: string[], defLineIdx: number): string[] {
  const decs: string[] = [];
  for (let j = defLineIdx - 1; j >= 0; j--) {
    const trimmed = lines[j]!.trimStart();
    if (trimmed.startsWith("@")) {
      decs.unshift(trimmed.slice(1));
    } else if (trimmed === "" || trimmed.startsWith("#")) {
      // Skip blanks/comments between decorators
      continue;
    } else {
      break;
    }
  }
  return decs;
}

/**
 * Extract docstring from the first statement in a body.
 * Looks for triple-quoted strings on the line immediately following a def/class.
 */
function extractDocstring(lines: string[], bodyStartIdx: number, expectedIndent: string): string | undefined {
  if (bodyStartIdx >= lines.length) return undefined;
  const firstLine = lines[bodyStartIdx]!;
  const trimmed = firstLine.trimStart();

  // Must start with triple quotes
  if (!trimmed.startsWith('"""') && !trimmed.startsWith("'''")) return undefined;
  const quote = trimmed.slice(0, 3);

  // Single-line docstring: """text"""
  if (trimmed.length > 6 && trimmed.endsWith(quote)) {
    return trimmed.slice(3, -3).trim();
  }

  // Multi-line docstring
  const docLines: string[] = [trimmed.slice(3)];
  for (let k = bodyStartIdx + 1; k < lines.length; k++) {
    const l = lines[k]!;
    const lt = l.trimStart();
    if (lt.includes(quote)) {
      const endIdx = lt.indexOf(quote);
      if (endIdx >= 0) {
        docLines.push(lt.slice(0, endIdx));
      }
      break;
    }
    // Strip expected indent from continuation lines
    docLines.push(l.startsWith(expectedIndent) ? l.slice(expectedIndent.length) : l.trimStart());
  }
  const result = docLines.join("\n").trim();
  // Truncate very long docstrings
  return result.length > 300 ? result.slice(0, 297) + "..." : result;
}

/**
 * Estimate end line of a block by finding the next line at same or lower indentation.
 * @param defIndent - character indent level of the def/class line (0 for top-level)
 */
function findBlockEnd(lines: string[], defLineIdx: number, defIndent: number): number {
  for (let k = defLineIdx + 1; k < lines.length; k++) {
    const line = lines[k]!;
    if (line.trim() === "") continue; // skip blank lines
    const indent = line.search(/\S/);
    if (indent >= 0 && indent <= defIndent) return k; // block ended at previous line
  }
  return lines.length;
}
