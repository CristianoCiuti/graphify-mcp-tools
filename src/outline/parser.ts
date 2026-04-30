import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../shared/utils.js";

// web-tree-sitter types (compatible with v0.24 and v0.25+)
export interface TreeSitterParser {
  parse(input: string): Tree;
  setLanguage(lang: Language): void;
}

interface Language {}

interface Tree {
  rootNode: SyntaxNode;
  delete(): void;
}

export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  childrenForFieldName?(name: string): SyntaxNode[];
}

let parserInstance: TreeSitterParser | null = null;
let languageLoaded = false;

/**
 * Initialize tree-sitter WASM parser with Python grammar.
 *
 * Supports web-tree-sitter v0.25+ API (named exports, Parser.init()).
 * Falls back to v0.24 API (default export, TreeSitter.init()) for compatibility.
 */
export async function initParser(grammarPath?: string): Promise<TreeSitterParser> {
  if (parserInstance && languageLoaded) return parserInstance;

  // Dynamic import for web-tree-sitter
  const mod = await import("web-tree-sitter");

  // v0.25+: named exports { Parser, Language }
  // v0.24:  default export with .init() and .Language.load()
  const ParserClass = (mod as Record<string, unknown>).Parser ?? (mod as Record<string, unknown>).default;
  if (!ParserClass || typeof ParserClass !== "function") {
    throw new Error("web-tree-sitter module does not export Parser or default");
  }

  // Initialize WASM runtime
  if (typeof (ParserClass as Record<string, unknown>).init === "function") {
    await (ParserClass as { init: () => Promise<void> }).init();
  }

  const parser = new (ParserClass as new () => TreeSitterParser)();

  // Resolve grammar WASM path
  const defaultGrammarPath = resolve(
    new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
    "../../grammars/tree-sitter-python.wasm",
  );
  const wasmPath = grammarPath ?? defaultGrammarPath;

  log.debug(`Loading grammar from: ${wasmPath}`);

  // Load language — v0.25+: Language.load(), v0.24: TreeSitter.Language.load()
  const LanguageClass = (mod as Record<string, unknown>).Language ?? (ParserClass as Record<string, unknown>).Language;
  if (!LanguageClass || typeof (LanguageClass as Record<string, unknown>).load !== "function") {
    throw new Error("Cannot find Language.load() in web-tree-sitter");
  }
  const language = await (LanguageClass as { load: (path: string) => Promise<Language> }).load(wasmPath);
  parser.setLanguage(language);

  parserInstance = parser;
  languageLoaded = true;
  log.info("Tree-sitter parser initialized with Python grammar");
  return parserInstance;
}

/**
 * Parse a Python source file and return its AST root node.
 */
export function parseFile(parser: TreeSitterParser, filePath: string): SyntaxNode {
  const source = readFileSync(filePath, "utf-8");
  return parseSource(parser, source);
}

/**
 * Parse Python source code and return its AST root node.
 */
export function parseSource(parser: TreeSitterParser, source: string): SyntaxNode {
  const tree = parser.parse(source);
  return tree.rootNode;
}
