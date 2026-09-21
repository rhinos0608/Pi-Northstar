#!/usr/bin/env node
import { commandHandler } from '../commands/command-registry.js';
import { createCommandContext } from '../commands/command-context.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from '../commands/command-result.js';

type Request = { commandId: string; args: Record<string, unknown> };
const MAX_COMMAND_ID_LENGTH = 64;
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

await main();

async function main(): Promise<void> {
  try {
    const request = parseRequest(await readStdin());
    let handler;
    try {
      handler = commandHandler(request.commandId);
    } catch {
      output({ ok: false, error: { code: 'unknown_command', message: 'Unknown command.' } }, 1);
      return;
    }
    try {
      const result = await handler.execute(
        request.args,
        createCommandContext({ surface: 'internal', env: process.env }),
      );
      const commandResult = extractCommandResult(result);
      if (!commandResult) {
        output({ ok: false, error: { code: 'command_result_invalid', message: 'Command result invalid.' } }, 1);
        return;
      }
      // Keep BackendCallResult details intact; canonical result is validated as an attached detail.
      output({ ok: true, data: result });
    } catch (error) {
      const commandResult = extractCommandResult(error);
      if (commandResult) output({ ok: true, data: error });
      else output({ ok: false, error: { code: 'command_result_invalid', message: 'Command result invalid.' } }, 1);
    }
  } catch {
    output({ ok: false, error: { code: 'invalid_worker_request', message: 'Invalid worker request.' } }, 1);
  }
}

function parseRequest(raw: string): Request {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid request'); }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'commandId' && key !== 'args') ||
      typeof value.commandId !== 'string' || value.commandId.length === 0 ||
      value.commandId.length > MAX_COMMAND_ID_LENGTH || !COMMAND_ID_PATTERN.test(value.commandId) ||
      !isRecord(value.args)) throw new Error('invalid request');
  return { commandId: value.commandId, args: value.args };
}

function extractCommandResult(value: unknown): NorthstarCommandResultV1 | undefined {
  const candidate = isRecord(value) && isRecord(value.details)
    ? value.details.northstarCommand
    : isRecord(value) && 'commandResult' in value
      ? value.commandResult
      : undefined;
  const validation = validateCommandResult(candidate);
  return validation.ok ? validation.result : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function output(value: unknown, exitCode?: number): void {
  console.log(JSON.stringify(value));
  if (exitCode !== undefined) process.exitCode = exitCode;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      text += chunk;
      if (text.length > 1_000_000) {
        process.stdin.destroy();
        reject(new Error('request too large'));
      }
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}
