# Tool guidance research note

Guidance-only overhaul. No names, schema, defaults, validation, or runtime changed.

## Rules applied

- Detailed descriptions drive tool selection: cover what/when/when-not/params/caveats; 3-4 sentences per tool, more when complex.
  Source: Anthropic, Define tools — https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use (accessed 2026-09-11).
- Clear names + params + system prompt; keep initial tool count small; describe each param format and what output represents; state when (and when not) to use each function.
  Source: OpenAI, Function calling — https://developers.openai.com/api/docs/guides/function-calling (accessed 2026-09-11).
- Examples only for complex/nested/format-sensitive inputs (Anthropic `input_examples`); adding examples can hurt reasoning models (OpenAI). Hence: DQL examples inline in `kg` description only (opaque format schema cannot express), one line each, no duplicates.
- MCP metadata: `title` display-only; `inputSchema` valid JSON Schema; names 1-128 chars `[A-Za-z0-9_.-]`; annotations are untrusted hints (defaults assume worst: `readOnlyHint/false, destructiveHint/true, idempotentHint/false, openWorldHint/true`); execution errors use `isError:true` with actionable text; validate inputs, confirm sensitive ops.
  Sources: MCP Server Tools 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/server/tools ; MCP Tool Annotations blog 2026-03-16 — https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations (accessed 2026-09-11).
- Diffbot DQL: every query begins with entity type (`type:Organization`, `type:Person`), e.g. `type:Organization locations.city.name:"San Francisco" nbEmployees>5000`.
  Source: Diffbot DQL Reference — https://www.diffbot.com/docs/dql/reference (accessed 2026-09-11).
- Diffbot Enhance: few identifiers in, full public-web entity out, plus confidence `score`. NL `content` 1-100000 chars required; returns entities/facts/relationships/sentiment/categories/summary/language.
  Sources: Enhance — https://www.diffbot.com/docs/enhance/ ; Process Text — https://www.diffbot.com/docs/natural-language/process-text ; NL reference — https://docs.diffbot.com/reference/nl-post (accessed 2026-09-11).
- Evaluation: no vendor benchmark quantifies description length; Pi-Northstar needs own selection-accuracy + DQL-validity eval before/after.
  Source: OpenAI Prompt optimizer — https://platform.openai.com/docs/guides/prompt-optimizer (accessed 2026-09-11).

## Runtime truths encoded (current worktree)

- `web_search` source/yearFrom research-only, ignored on plain search by contract; cursor research + exact source only; knowledge web-only.
- `fetch` needs url or searchQuery with query; query alone throws; followLinks needs url + query.
- `social` limit over-cap rejects across the canonical request contract; some platform/action pairs have stricter caps (for example LinkedIn people search); cursor pins backend.
- `kg`: action default search; search limit 10/50; enhance maxEntities 1/10; cursor opaque, fingerprint-pinned, single-provider auto only; fields/includeRelationships/includeEvidence/confidenceThreshold client-side only; score is not confidence; missing confidence retained; maxProviders operator cap wins; sequential auto fallback only; privacy advisory.
