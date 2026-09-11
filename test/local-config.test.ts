import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadedConfigSummary, loadSearchMcpEnvironment, readDiffbotTokenFromLoginShell } from '../src/local-config.js';

test('loadSearchMcpEnvironment does not assume a developer-specific default config path', () => {
  const env = { PI_SEARCH_ENV_PATH: '/tmp/missing-pi-search-env' };
  assert.deepEqual(loadSearchMcpEnvironment(env), env);
  assert.deepEqual(loadedConfigSummary(env), { path: '', loaded: false, mappedKeys: [] });
});

test('loadSearchMcpEnvironment loads package env file before config mapping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-env-'));
  const envPath = join(dir, '.env');
  const configPath = join(dir, 'config.json');
  await writeFile(envPath, `PI_SEARCH_BOOTSTRAP=auto\nSEARCH_MCP_CONFIG_PATH=${configPath}\nEXA_API_KEY=from-env-file\n`);
  await writeFile(configPath, JSON.stringify({ exa: { apiKey: 'from-config' }, github: { token: 'gh-token' } }));

  const env = loadSearchMcpEnvironment({ PI_SEARCH_ENV_PATH: envPath });

  assert.equal(env.PI_SEARCH_BOOTSTRAP, 'auto');
  assert.equal(env.SEARCH_MCP_CONFIG_PATH, configPath);
  assert.equal(env.EXA_API_KEY, 'from-env-file');
  assert.equal(env.GITHUB_TOKEN, 'gh-token');
});

test('loadSearchMcpEnvironment maps search-mcp config keys without overriding env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    exa: { apiKey: 'from-config' },
    github: { token: 'gh-token' },
    crawl4ai: { baseUrl: 'https://crawl.example', apiToken: 'crawl-token' },
  }));

  const env = loadSearchMcpEnvironment({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path, EXA_API_KEY: 'from-env' });

  assert.equal(env.EXA_API_KEY, 'from-env');
  assert.equal(env.GITHUB_TOKEN, 'gh-token');
  assert.equal(env.CRAWL4AI_BASE_URL, 'https://crawl.example');
  assert.equal(env.CRAWL4AI_API_TOKEN, 'crawl-token');
});

test('loadedConfigSummary reports keys only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ brave: { apiKey: 'secret' } }));

  assert.deepEqual(loadedConfigSummary({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path }), {
    path,
    loaded: true,
    mappedKeys: ['BRAVE_API_KEY'],
  });
});

test('loadSearchMcpEnvironment ignores malformed config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, '{bad json');

  const env = { PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path };
  assert.deepEqual(loadSearchMcpEnvironment(env), env);
  assert.deepEqual(loadedConfigSummary(env), { path, loaded: false, mappedKeys: [] });
});

test('loadSearchMcpEnvironment ignores placeholder null strings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ llm: { apiToken: 'null' } }));

  assert.equal(loadSearchMcpEnvironment({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path }).SEARCH_LLM_API_TOKEN, undefined);
});

test('optional research API keys map from config without overriding env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-research-keys-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    semanticScholar: { apiKey: 's2-key-from-config' },
    openalex: { apiKey: 'openalex-key-from-config' },
    ncbi: { apiKey: 'ncbi-key-from-config', email: 'research@example.com' },
    stackexchange: { key: 'se-key-from-config' },
  }));

  const env = loadSearchMcpEnvironment({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path, OPENALEX_API_KEY: 'from-env' });

  assert.equal(env.SEMANTIC_SCHOLAR_API_KEY, 's2-key-from-config');
  assert.equal(env.OPENALEX_API_KEY, 'from-env');
  assert.equal(env.NCBI_API_KEY, 'ncbi-key-from-config');
  assert.equal(env.NCBI_EMAIL, 'research@example.com');
  assert.equal(env.STACKEXCHANGE_KEY, 'se-key-from-config');

  const summary = loadedConfigSummary({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path });
  assert.ok(summary.mappedKeys.includes('SEMANTIC_SCHOLAR_API_KEY'));
  assert.ok(summary.mappedKeys.includes('NCBI_EMAIL'));
});

test('diffbot keys map from config without overriding env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-diffbot-keys-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    diffbot: {
      token: 'diffbot-token-from-config',
      searchSize: 20,
      enhanceSize: 2,
      nlpMaxChars: 50000,
      maxProviders: 2,
      fallbackBudget: 5,
    },
  }));

  const base = { PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path };
  const env = loadSearchMcpEnvironment(base);
  assert.equal(env.DIFFBOT_TOKEN, 'diffbot-token-from-config');
  assert.equal(env.DIFFBOT_SEARCH_SIZE, '20');
  assert.equal(env.DIFFBOT_ENHANCE_SIZE, '2');
  assert.equal(env.DIFFBOT_NLP_MAX_CHARS, '50000');
  assert.equal(env.DIFFBOT_MAX_PROVIDERS, '2');
  assert.equal(env.DIFFBOT_FALLBACK_BUDGET, '5');

  const override = loadSearchMcpEnvironment({ ...base, DIFFBOT_TOKEN: 'from-env' });
  assert.equal(override.DIFFBOT_TOKEN, 'from-env');

  const summary = loadedConfigSummary(base);
  for (const key of ['DIFFBOT_TOKEN', 'DIFFBOT_SEARCH_SIZE', 'DIFFBOT_ENHANCE_SIZE', 'DIFFBOT_NLP_MAX_CHARS', 'DIFFBOT_MAX_PROVIDERS', 'DIFFBOT_FALLBACK_BUDGET']) {
    assert.ok(summary.mappedKeys.includes(key), `summary must list ${key}`);
  }
});

test('firecrawl/jina keys map from config without overriding env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-firecrawl-jina-keys-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    firecrawl: { apiKey: 'firecrawl-key-from-config' },
    jina: { apiKey: 'jina-key-from-config' },
  }));

  const base = { PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path };
  const env = loadSearchMcpEnvironment(base);
  assert.equal(env.FIRECRAWL_API_KEY, 'firecrawl-key-from-config');
  assert.equal(env.JINA_API_KEY, 'jina-key-from-config');

  const override = loadSearchMcpEnvironment({ ...base, FIRECRAWL_API_KEY: 'from-env' });
  assert.equal(override.FIRECRAWL_API_KEY, 'from-env');
  assert.equal(override.JINA_API_KEY, 'jina-key-from-config');

  const summary = loadedConfigSummary(base);
  assert.ok(summary.mappedKeys.includes('FIRECRAWL_API_KEY'), 'summary must list FIRECRAWL_API_KEY');
  assert.ok(summary.mappedKeys.includes('JINA_API_KEY'), 'summary must list JINA_API_KEY');
});

test('no JSON mapping exists for environment-only selection/AI policy keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-no-policy-mapping-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    web: { backends: 'exa', providerTimeoutMs: 5000, nativeSummaries: true, nativeAnswers: true, kgEnrichment: true, externalFetch: true, fetchBackends: 'jina', fetchProviderTimeoutMs: 5000 },
  }));

  const env = loadSearchMcpEnvironment({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path });
  for (const key of ['PI_SEARCH_WEB_BACKENDS', 'PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS', 'PI_SEARCH_NATIVE_SUMMARIES', 'PI_SEARCH_NATIVE_ANSWERS', 'PI_SEARCH_KG_ENRICHMENT', 'PI_SEARCH_EXTERNAL_FETCH', 'PI_SEARCH_FETCH_BACKENDS', 'PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS']) {
    assert.equal(env[key], undefined, `${key} must stay env-only with no JSON mapping`);
  }
});

test('DIFFBOT_TOKEN login-shell fallback fills only when configured sources are blank', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-diffbot-shell-'));
  const base = { PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: join(dir, 'missing.json') };
  let probes = 0;
  const fallback = loadSearchMcpEnvironment(base, {
    allowLoginShellFallback: true,
    readLoginShellToken: () => { probes += 1; return 'shell-token'; },
  });
  assert.equal(fallback.DIFFBOT_TOKEN, 'shell-token');
  assert.equal(probes, 1);

  const explicit = loadSearchMcpEnvironment({ ...base, DIFFBOT_TOKEN: 'from-env' }, {
    allowLoginShellFallback: true,
    readLoginShellToken: () => { probes += 1; return 'shell-token'; },
  });
  assert.equal(explicit.DIFFBOT_TOKEN, 'from-env');
  assert.equal(probes, 1);

  const hermetic = loadSearchMcpEnvironment(base);
  assert.equal(hermetic.DIFFBOT_TOKEN, undefined);
});

test('login-shell resolver uses configured SHELL login+interactive argv and ignores stdout noise', () => {
  let seen: { file: string; args: readonly string[] } | undefined;
  const token = readDiffbotTokenFromLoginShell({
    shell: '/tmp/fake-login-shell/zsh',
    spawn: ((file: string, args: string[]) => {
      seen = { file, args };
      return {
        output: [
          undefined,
          Buffer.from('banner noise from zshrc\n'),
          undefined,
          Buffer.from('PI_ATLAS_TOKEN_START\nfake-token-abc\nPI_ATLAS_TOKEN_END\n'),
        ],
      };
    }) as never,
  });
  assert.equal(token, 'fake-token-abc');
  assert.equal(seen?.file, '/tmp/fake-login-shell/zsh');
  assert.deepEqual(seen?.args.slice(0, 3), ['-l', '-i', '-c']);
});

test('login-shell resolver falls back to /bin/sh for absent or invalid SHELL', () => {
  const seen: string[] = [];
  const probe = (shell: string | undefined) => readDiffbotTokenFromLoginShell({
    ...(shell === undefined ? {} : { shell }),
    spawn: ((file: string) => {
      seen.push(file);
      return { output: [undefined, Buffer.from(''), undefined, Buffer.from('')] };
    }) as never,
  });
  const savedShell = process.env.SHELL;
  try {
    delete process.env.SHELL;
    assert.equal(probe(undefined), undefined);
  } finally {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  }
  assert.equal(probe('evil; rm -rf /'), undefined);
  assert.equal(probe('relative/path/zsh'), undefined);
  assert.deepEqual(seen, ['/bin/sh', '/bin/sh', '/bin/sh']);
});

test('login-shell resolver fails closed on spawn error or blank frame', () => {
  const errToken = readDiffbotTokenFromLoginShell({
    shell: '/bin/sh',
    spawn: (() => ({ error: new Error('boom') })) as never,
  });
  assert.equal(errToken, undefined);
  const blankToken = readDiffbotTokenFromLoginShell({
    shell: '/bin/sh',
    spawn: (() => ({
      output: [undefined, Buffer.from('noise'), undefined, Buffer.from('PI_ATLAS_TOKEN_START\n   \nPI_ATLAS_TOKEN_END\n')],
    })) as never,
  });
  assert.equal(blankToken, undefined);
});

test('login-shell resolver rejects duplicate frames or extra fd3 bytes', () => {
  const fd3 = (text: string) => readDiffbotTokenFromLoginShell({
    shell: '/bin/sh',
    spawn: (() => ({
      output: [undefined, Buffer.from(''), undefined, Buffer.from(text)],
    })) as never,
  });
  assert.equal(fd3('PI_ATLAS_TOKEN_START\nfake-a\nPI_ATLAS_TOKEN_END\nPI_ATLAS_TOKEN_START\nfake-b\nPI_ATLAS_TOKEN_END\n'), undefined);
  assert.equal(fd3('noisePI_ATLAS_TOKEN_START\nfake-a\nPI_ATLAS_TOKEN_END\n'), undefined);
  assert.equal(fd3('PI_ATLAS_TOKEN_START\nfake-a\nPI_ATLAS_TOKEN_END\ntrailing'), undefined);
  assert.equal(fd3('PI_ATLAS_TOKEN_START\nmulti\nline\nPI_ATLAS_TOKEN_END\n'), undefined);
});

test('login-shell resolver reads temp fake shell without real credentials', async () => {
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pi-fake-shell-'));
  const shellPath = join(dir, 'zsh');
  await writeFile(shellPath, '#!/bin/sh\necho "banner noise"\nprintf \'PI_ATLAS_TOKEN_START\\n%s\\nPI_ATLAS_TOKEN_END\\n\' "fake-token-e2e" >&3\n');
  await chmod(shellPath, 0o755);
  const token = readDiffbotTokenFromLoginShell({ shell: shellPath });
  assert.equal(token, 'fake-token-e2e');
});
