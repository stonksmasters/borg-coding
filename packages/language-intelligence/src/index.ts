export interface CodeLocation {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface SymbolResult extends CodeLocation {
  name: string;
  kind: string;
  container?: string;
}

export interface DiagnosticResult extends CodeLocation {
  category: "error" | "warning" | "suggestion" | "message";
  code: number;
  message: string;
}

export interface LanguageIntelligenceProvider {
  readonly id: string;
  supports(path: string): boolean;
  symbols(query: string, limit?: number): Promise<SymbolResult[]>;
  definitions(path: string, line: number, column: number): Promise<CodeLocation[]>;
  references(path: string, line: number, column: number): Promise<CodeLocation[]>;
  implementations(path: string, line: number, column: number): Promise<CodeLocation[]>;
  diagnostics(path?: string): Promise<DiagnosticResult[]>;
}
