export type Severity = "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface Finding {
  /** Stable rule id, e.g. AUTH002 or MIG001 */
  ruleId: string;
  severity: Severity;
  /** One-line summary */
  title: string;
  /** What is wrong in this specific location */
  message: string;
  /** Concrete suggested fix */
  fix: string;
  /** Path relative to the project root, using forward slashes */
  file: string;
  /** 1-based line number */
  line: number;
}

export interface RuleMeta {
  id: string;
  name: string;
  severity: Severity;
  description: string;
}
