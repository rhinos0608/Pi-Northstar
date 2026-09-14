// Plan E1 clone tests: fake git binary fixture, argv smuggling, sentinel
// env leak, cleanup on abort/failure, no anonymous retry after auth failure.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialError } from '../../src/social/social-contract.js';
import {
  buildGithubGitCloneArgv,
  cloneGithubRepo,
  createGithubCloneWorker,
  defaultGithubCloneRunner,
  isGithubCloneAuthFailure,
  type GithubCloneResult,
  type GithubCloneRunner,
  type GithubCloneDependencies,
} from '../../src/github/github-clone.js';
import type { GithubRequest } from '../../src/github/github-contract.js';

interface RecordedCall {
  command: string;
  argv: readonly string[];
  env: Record<string, string>;
  cwd: string;
}

function enoent(): Error {
  return Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
}

function destOf(command: string, argv: readonly string[]): string {
  if (command === 'gh') return argv[3] as string;
  return argv[argv.length - 1] as string;
}

async function materialize(dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await mkdir(join(dest, '.git'), { recursive: true });
  await writeFile(join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(dest, 'README.md'), 'hello clone\n');
  await writeFile(join(dest, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
}

function successRunner(calls: RecordedCall[]): GithubCloneRunner {
  return async (command, argv, options) => {
    calls.push({ command, argv, env: options.env, cwd: options.cwd });
    if (command === 'gh') throw enoent();
    await materialize(destOf(command, argv));
    return { stdout: '', stderr: '', code: 0 };
  };
}

async function assertRemoved(path: string): Promise<void> {
  await assert.rejects(stat(path), 'clone root must be removed unconditionally');
}

test('fixed git argv disables hooks/filters/LFS/submodules, rejects smuggling', () => {
  const built = buildGithubGitCloneArgv({
    owner: 'octo',
    repo: 'kit',
    ref: 'main',
    destDir: '/tmp/dest',
    credentialHelper: '/tmp/root/askpass.sh',
    emptyHooksDir: '/tmp/root/no-hooks',
  });
  assert.equal(built.command, 'git');
  assert.ok(Array.isArray(built.argv));
  for (const flag of [
    '--no-recurse-submodules',
    '--no-replace-objects',
    '--no-hardlinks',
    'core.hooksPath=/tmp/root/no-hooks',
    'core.fsmonitor=false',
    'submodule.recurse=false',
    'filter.lfs.smudge=',
    'filter.lfs.process=',
    'protocol.file.allow=never',
  ]) {
    assert.ok(built.argv.includes(flag), `argv carries ${flag}`);
  }
  assert.ok(!built.argv.some((entry) => entry === '--recurse-submodules'));
  assert.ok(built.argv.includes('--branch') && built.argv.includes('main'));
  assert.ok(!built.argv.join(' ').includes('octo/kit --branch='));
});

test('ref and slug smuggling never reaches the runner', async () => {
  let calls = 0;
  const boom: GithubCloneRunner = async () => {
    calls += 1;
    return { stdout: '', stderr: '', code: 0 };
  };
  for (const ref of ['--upload-pack=id', '-u', '../x', 'a:b']) {
    await assert.rejects(cloneGithubRepo({ owner: 'o', repo: 'r', ref }, { runProcess: boom }), (error: unknown) => {
      assert.ok(error instanceof SocialError && error.code === 'invalid_request');
      return true;
    });
  }
  await assert.rejects(cloneGithubRepo({ owner: '-o', repo: 'r' }, { runProcess: boom }), (error: unknown) => {
    assert.ok(error instanceof SocialError && error.code === 'invalid_request');
    return true;
  });
  assert.equal(calls, 0);
});

test('sanitized env carries no sentinel; token never in argv', async () => {
  const calls: RecordedCall[] = [];
  const parentEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? '/tmp',
    TEST_SECRET_TOKEN: 'sentinel-secret',
    MY_API_KEY: 'sentinel-key',
    GITHUB_TOKEN: 'sentinel-token',
  };
  const outcome = await cloneGithubRepo(
    { owner: 'octo', repo: 'kit' },
    { parentEnv, runProcess: successRunner(calls) },
  );
  assert.ok(calls.length >= 1);
  const gitCall = calls.find((call) => call.command === 'git');
  assert.ok(gitCall);
  assert.equal(gitCall.env.TEST_SECRET_TOKEN, undefined);
  assert.equal(gitCall.env.MY_API_KEY, undefined);
  assert.equal(gitCall.env.GITHUB_TOKEN, undefined);
  assert.equal(gitCall.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(gitCall.env.GIT_LFS_SKIP_SMUDGE, '1');
  assert.ok(gitCall.env.GIT_ASKPASS);
  for (const call of calls) {
    assert.ok(!call.argv.join(' ').includes('sentinel'), 'argv must not carry secrets');
    assert.ok(!Object.values(call.env).join(' ').includes('sentinel'), 'child env must not carry secrets');
  }
  assert.ok(outcome.payload.files.some((file) => file.path === 'README.md'));
  assert.ok(outcome.payload.metadataOnly.includes('bin.dat'));
  assert.ok(!JSON.stringify(outcome.payload).includes('sentinel'));
  await assertRemoved(calls[0]?.cwd as string);
});

test('private-repo gh auth failure falls back to git which owns the helper', async () => {
  const calls: RecordedCall[] = [];
  const token = 'private-repo-token';
  const runner: GithubCloneRunner = async (command, argv, options) => {
    calls.push({ command, argv, env: options.env, cwd: options.cwd });
    if (command === 'gh') return { stdout: '', stderr: 'ERROR: repository not found', code: 1 };
    await materialize(destOf(command, argv));
    return { stdout: '', stderr: '', code: 0 };
  };
  const outcome = await cloneGithubRepo({ owner: 'o', repo: 'r' }, { token, runProcess: runner });
  assert.ok(calls.some((call) => call.command === 'git'), 'gh auth failure must fall back to git');
  assert.ok(outcome.payload.files.some((file) => file.path === 'README.md'));
  for (const call of calls) {
    assert.ok(!call.argv.join(' ').includes(token), 'argv must not carry secrets');
    assert.ok(!Object.values(call.env).join(' ').includes(token), 'child env must not carry secrets');
  }
  assert.ok(!JSON.stringify(outcome.payload).includes(token));
  assert.ok(!outcome.warnings.join(' ').includes(token));
  await assertRemoved(calls[0]?.cwd as string);
});

test('credential helper speaks git protocol; token never in stderr-derived errors', async () => {
  const token = 'stderr-secret-token';
  let helperGet = '';
  let helperAskpass = '';
  const runner: GithubCloneRunner = async (command, _argv, options) => {
    const helper = options.env.GIT_ASKPASS;
    assert.ok(helper, 'GIT_ASKPASS must be set');
    helperGet = execFileSync('sh', [helper, 'get'], { encoding: 'utf8' });
    helperAskpass = execFileSync('sh', [helper, 'prompt text'], { encoding: 'utf8' });
    if (command === 'gh') throw enoent();
    return { stdout: '', stderr: `fatal: unable to access 'https://${token}@github.com/o/r.git/': Could not resolve host`, code: 128 };
  };
  await assert.rejects(cloneGithubRepo({ owner: 'o', repo: 'r' }, { token, runProcess: runner }), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.ok(!String(error.message).includes(token), 'error message must not carry the token');
    assert.ok(!JSON.stringify(error).includes(token), 'error body must not carry the token');
    return true;
  });
  assert.match(helperGet, /^username=\S+\npassword=\S+\n\n$/, 'helper get must emit credential-helper protocol lines');
  assert.ok(!helperGet.replace(`password=${token}`, '').includes(token), 'token appears only inside the password= line');
  assert.equal(helperAskpass, token);
  const helperBody = helperGet;
  assert.ok(helperBody.length > 0);
});

test('cleanup runs on clone failure', async () => {
  const calls: RecordedCall[] = [];
  const failing: GithubCloneRunner = async (command, argv, options) => {
    calls.push({ command, argv, env: options.env, cwd: options.cwd });
    if (command === 'gh') throw enoent();
    throw new Error('boom');
  };
  await assert.rejects(cloneGithubRepo({ owner: 'o', repo: 'r' }, { runProcess: failing }), /boom|upstream_error/);
  assert.ok(calls.length >= 1);
  await assertRemoved(calls[0]?.cwd as string);
});

test('cleanup runs on abort', async () => {
  const calls: RecordedCall[] = [];
  const controller = new AbortController();
  const hanging: GithubCloneRunner = async (_command, _argv, options) => {
    calls.push({ command: _command, argv: _argv, env: options.env, cwd: options.cwd });
    if (options.signal?.aborted) throw new Error('Aborted');
    await new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
    throw new Error('unreachable');
  };
  const pending = cloneGithubRepo({ owner: 'o', repo: 'r' }, { runProcess: hanging }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /Abort/);
  assert.ok(calls.length >= 1);
  await assertRemoved(calls[0]?.cwd as string);
});

test('no anonymous retry after authenticated failure', async () => {
  const seen: string[] = [];
  const authFail: GithubCloneRunner = async (command) => {
    seen.push(command);
    return { stdout: '', stderr: 'fatal: Authentication failed for repo', code: 128 } satisfies GithubCloneResult;
  };
  const deps: GithubCloneDependencies = { token: 'configured-token', runProcess: authFail };
  await assert.rejects(cloneGithubRepo({ owner: 'o', repo: 'r' }, deps), (error: unknown) => {
    assert.ok(error instanceof SocialError && error.code === 'authentication_required');
    return true;
  });
  // gh runs token-stripped so its auth failure falls back to git (which owns
  // the credential helper); git carried the token, so no anonymous retry.
  assert.deepEqual(seen, ['gh', 'git']);
});

test('gh absent degrades with warning, git carries the clone', async () => {
  const calls: RecordedCall[] = [];
  const outcome = await cloneGithubRepo({ owner: 'o', repo: 'r' }, { runProcess: successRunner(calls) });
  assert.equal(outcome.ghAbsent, true);
  assert.ok(outcome.warnings.join(' ').includes('REST-only'));
  assert.ok(calls.some((call) => call.command === 'git'));
});

test('auth failure detection is code-gated', () => {
  assert.equal(isGithubCloneAuthFailure('', 0), false);
  assert.equal(isGithubCloneAuthFailure('fatal: Authentication failed', 128), true);
  assert.equal(isGithubCloneAuthFailure('ERROR: Permission denied (publickey)', 1), true);
  assert.equal(isGithubCloneAuthFailure('repository not found', 128), true);
  assert.equal(isGithubCloneAuthFailure('boom', 1), false);
});

test('default runner uses fixed argv echo without a shell string', async () => {
  const result = await defaultGithubCloneRunner(
    process.execPath,
    ['-e', 'process.stdout.write("hi")'],
    { env: { PATH: process.env.PATH ?? '' }, cwd: tmpdir(), timeoutMs: 10_000 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hi');
});

function repoRequest(): GithubRequest {
  return { action: 'repo', limit: 20, owner: 'octo', repo: 'kit' };
}

test('worker seam declares clone plans for repo/tree only', async () => {
  const worker = createGithubCloneWorker({ runProcess: successRunner([]) });
  assert.deepEqual(worker.backends, ['github-clone']);
  const plans = await worker.plans(repoRequest(), {});
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.backend, 'github-clone');
  assert.equal(plans[0]?.pagination, 'unsupported');
  const searchPlans = await worker.plans({ action: 'search', limit: 20, query: 'x' }, {});
  assert.deepEqual(searchPlans, []);
});

test('worker normalize builds a tree page, rejects foreign backends', async () => {
  const calls: RecordedCall[] = [];
  const worker = createGithubCloneWorker({ runProcess: successRunner(calls) });
  const [plan] = await worker.plans(repoRequest(), {});
  assert.ok(plan);
  const payload = (await plan.execute()) as Parameters<typeof worker.normalize>[2];
  const page = worker.normalize(repoRequest(), plan, payload);
  assert.equal(page.entities.length, 1);
  assert.equal(page.entities[0]?.kind, 'tree');
  assert.ok((page.entities[0]?.id as string).includes('octo/kit'));
  assert.throws(
    () =>
      worker.normalize(repoRequest(), { ...plan, backend: 'github-api' }, payload),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
});
