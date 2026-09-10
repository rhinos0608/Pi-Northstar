#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { callNativeTool } from './native-tools.js';
import { DEFAULT_SEARCH_MCP_COMMAND, buildServerParameters } from './mcp-client.js';
import type { BackendCallResult } from './backend.js';
import { SocialError } from './social-contract.js';
import { loadedConfigSummary, loadSearchMcpEnvironment } from './local-config.js';

interface CliResult {
  ok: boolean;
  data?: BackendCallResult | unknown;
  error?: {
    code: string;
    message: string;
    platform?: string;
    backend?: string;
  };
}

if (isMainModule()) {
  try {
    const result = await runCommand(process.argv.slice(2), loadSearchMcpEnvironment(process.env));
    writeResult(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    writeResult(errorResult('internal_error', error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

export async function runCommand(args: string[] | string | undefined, env: Record<string, string | undefined>): Promise<CliResult> {
  const argv = Array.isArray(args) ? args : [args].filter((value): value is string => typeof value === 'string');
  const commandName = argv[0];

  if (commandName === 'status') return statusResult(env);
  if (commandName === 'config') return configResult(env);
  if (commandName === 'call') return callResult(argv[1], argv[2], env);

  return errorResult('unknown_command', 'Usage: pi-northstar <status|config|call TOOL JSON_ARGS>');
}

async function callResult(toolName: string | undefined, rawArgs: string | undefined, env: Record<string, string | undefined>): Promise<CliResult> {
  if (!toolName) return errorResult('missing_tool', 'Tool name is required.');
  const parsed = parseJsonArgs(rawArgs);
  if (!parsed.ok) return parsed;
  try {
    const data = await callNativeTool(toolName, parsed.data as Record<string, unknown>, { env });
    return { ok: true, data };
  } catch (error) {
    return cliToolError(error);
  }
}

/** Map tool failures to the CLI envelope. SocialError codes pass through
 * with platform/backend context; plain Errors collapse to 'tool_error'.
 * Messages are pre-scrubbed at worker level; this path never adds raw
 * URL/body material. */
export function cliToolError(error: unknown): CliResult {
  if (error instanceof SocialError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.platform !== undefined ? { platform: error.platform } : {}),
        ...(error.backend !== undefined ? { backend: error.backend } : {}),
      },
    };
  }
  return errorResult('tool_error', error instanceof Error ? error.message : String(error));
}

function statusResult(env: Record<string, string | undefined>): CliResult {
  const parameters = buildServerParameters(env);

  return {
    ok: true,
    data: {
      backend: env.SEARCH_BACKEND === 'mcp' ? 'mcp-stdio' : 'native-cli',
      command: parameters.command,
      args: parameters.args,
      cwd: parameters.cwd ?? null,
      defaultCommand: DEFAULT_SEARCH_MCP_COMMAND,
    },
  };
}

function configResult(env: Record<string, string | undefined>): CliResult {
  return {
    ok: true,
    data: {
      searchBackend: env.SEARCH_BACKEND ?? 'native-cli',
      searchMcpCommand: env.SEARCH_MCP_COMMAND?.trim() || DEFAULT_SEARCH_MCP_COMMAND,
      searchMcpArgsJson: env.SEARCH_MCP_ARGS_JSON ?? '[]',
      searchMcpCwd: env.SEARCH_MCP_CWD ?? null,
      localConfig: loadedConfigSummary(env),
    },
  };
}

function parseJsonArgs(raw: string | undefined): CliResult {
  if (!raw) return { ok: true, data: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return errorResult('invalid_args', 'JSON_ARGS must be an object.');
    }
    return { ok: true, data: parsed };
  } catch (error) {
    return errorResult('invalid_args', error instanceof Error ? error.message : String(error));
  }
}

function errorResult(code: string, message: string): CliResult {
  return { ok: false, error: { code, message } };
}

function writeResult(result: CliResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function isMainModule(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}
