import { isAgentInvocation } from "./agent-detect.ts";

export type OutputFormat = "json" | "table";

// Precedence: explicit flag > agent env var > TTY sniff (frappe-ctl ADR-008/023).
// Agent harnesses sometimes attach a pty, so isTTY alone can lie.
export function detectFormat(flag?: string): OutputFormat {
  if (flag === "json") return "json";
  if (flag === "table") return "table";
  if (isAgentInvocation()) return "json";
  return process.stdout.isTTY ? "table" : "json";
}

export function printDocs(docs: Record<string, unknown>[], format: OutputFormat): void {
  if (!docs.length) {
    if (format === "json") process.stdout.write("[]\n");
    else console.log("No results.");
    return;
  }
  if (format === "json") {
    process.stdout.write(JSON.stringify(docs, null, 2) + "\n");
    return;
  }
  printTable(docs);
}

export function printDoc(doc: Record<string, unknown>, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
    return;
  }
  for (const [k, v] of Object.entries(doc)) {
    if (v === null || v === undefined || v === "") continue;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    console.log(`${k.padEnd(24)} ${val}`);
  }
}

function printTable(docs: Record<string, unknown>[]): void {
  const keys = Object.keys(docs[0]!);
  const widths = keys.map((k) =>
    Math.min(48, Math.max(k.length, ...docs.map((d) => String(d[k] ?? "").length))),
  );
  const row = (vals: string[]) =>
    vals.map((v, i) => v.slice(0, widths[i]!).padEnd(widths[i]!)).join("  ");
  console.log(row(keys));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const doc of docs) {
    console.log(row(keys.map((k) => String(doc[k] ?? ""))));
  }
}
