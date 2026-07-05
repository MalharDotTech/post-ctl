// Known env vars set by AI coding agents/CLIs. Presence forces JSON output
// (output.ts::detectFormat) even when process.stdout.isTTY lies — some agent
// harnesses attach a pty, so TTY-only detection can silently ship table
// output to an agent that can't parse it. Ported from frappe-ctl (ADR-023);
// list verified against the is-ai-agent Rust crate's source.
export const AGENT_ENV_VARS = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_EXECPATH",
  "CURSOR_AGENT", "CURSOR_SANDBOX",
  "QWEN_CODE",
  "GEMINI_CLI",
  "CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "CLINE_ACTIVE",
  "ROO_ACTIVE",
  "CRUSH",
  "IFLOW_CLI",
  "OPENCODE", "OPENCODE_PID", "OPENCODE_CLIENT",
  "TRAE_AI_SHELL_ID",
  "GOOSE_TERMINAL",
  "REPL_ID",
  "COPILOT_AGENT_SESSION_ID", "COPILOT_MODEL", "COPILOT_ALLOW_ALL", "COPILOT_GITHUB_TOKEN",
  "AMP_CURRENT_THREAD_ID",
];

// Generic fallback for tools not in the list above — gh/kubectl convention.
const GENERIC_AGENT_ENV_VARS = ["AGENT", "AI_AGENT"];

export function isAgentInvocation(): boolean {
  for (const v of [...AGENT_ENV_VARS, ...GENERIC_AGENT_ENV_VARS]) {
    if (process.env[v]) return true;
  }
  return false;
}
