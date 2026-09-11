import test from 'node:test';
import assert from 'node:assert/strict';
import { presentPageText } from '../src/web-presentation.js';

const MARKER_RE = /\[truncated: showing \d+ of \d+ chars; raise maxChars up to 50000 for more\]/;

function markerCount(text: string): number {
  return text.split('[truncated:').length - 1;
}

test('fitting content passes through unchanged with no marker', () => {
  const content = 'Short page words. Two sentences here.';
  const out = presentPageText(content, 500);
  assert.equal(out.text, content);
  assert.equal(out.shown, content);
  assert.equal(out.truncated, false);
  assert.equal(out.omittedChars, 0);
});

test('output never exceeds maxChars across budgets', () => {
  const content = `${'Alpha beta gamma delta. '.repeat(40)}\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n${'Trailing words follow. '.repeat(20)}`;
  for (const maxChars of [10, 50, 100, 200, 500, 1000]) {
    const out = presentPageText(content, maxChars);
    assert.ok(out.text.length <= maxChars, `budget ${maxChars}: got ${out.text.length}`);
    assert.equal(out.truncated, true);
    // Budgets below the marker length carry a clipped marker-only slice.
    if (maxChars >= 100) assert.equal(markerCount(out.text), 1);
  }
});

test('oversized prose ends at a complete sentence, not mid-paragraph', () => {
  const content = `${'Sentence one states a fact. '.repeat(10)}${'Sentence two adds detail. '.repeat(30)}`;
  const out = presentPageText(content, 300);
  assert.ok(out.text.length <= 300);
  assert.match(out.text, MARKER_RE);
  const shown = out.text.slice(0, out.text.indexOf('[truncated'));
  assert.match(shown.trimEnd().slice(-1), /[.!?…]/);
});

test('fenced code block is atomic: whole or skipped, never split', () => {
  const fence = '```js\nconst alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n```';
  const content = `Intro sentence one. Intro sentence two.\n\n${fence}\n\n${'Closing filler words here. '.repeat(40)}`;
  for (const maxChars of [150, 250, 400, 800]) {
    const out = presentPageText(content, maxChars);
    assert.ok(out.text.length <= maxChars);
    const fences = (out.text.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, `budget ${maxChars}: split fence`);
    if (fences > 0) assert.match(out.text, /const gamma = 3;/);
  }
});

test('table block is atomic: all rows or none', () => {
  const table = '| name | value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |';
  const content = `Lead paragraph one. Lead paragraph two.\n\n${table}\n\n${'Tail filler words here. '.repeat(40)}`;
  for (const maxChars of [150, 300, 700]) {
    const out = presentPageText(content, maxChars);
    assert.ok(out.text.length <= maxChars);
    const hasFirst = out.text.includes('| alpha | 1 |');
    const hasLast = out.text.includes('| beta | 2 |');
    assert.equal(hasFirst, hasLast, `budget ${maxChars}: partial table`);
  }
});

test('pipe navigation chrome is removed while article text stays', () => {
  const content = `Home | About | Contact | Privacy\n\n${'Article substance words follow. '.repeat(40)}`;
  const out = presentPageText(content, 400);
  assert.doesNotMatch(out.text, /Contact/);
  assert.match(out.text, /Article substance/);
});

test('link-list navigation is removed', () => {
  const content = `[Home](https://example.com/)\n[About](https://example.com/about)\n[Contact](https://example.com/contact)\n[Pricing](https://example.com/pricing)\n\n${'Real article content words. '.repeat(40)}`;
  const out = presentPageText(content, 400);
  assert.doesNotMatch(out.text, /Pricing/);
  assert.match(out.text, /Real article content/);
});

test('blockquote blocks are exempt from navigation removal', () => {
  const content = `> Home\n> About\n> Contact\n\n${'Body copy words here. '.repeat(30)}`;
  const out = presentPageText(content, 400);
  assert.match(out.text, /Contact/);
});

test('code blocks are exempt from navigation-density removal', () => {
  const content = '```\na | b | c | d\nx | y | z | w\n```';
  const out = presentPageText(content, 500);
  assert.equal(out.truncated, false);
  assert.match(out.text, /\|/);
});

test('non-HTTP links neutralize to labels; HTTP links stay intact', () => {
  const content = 'Read [click me](javascript:alert(1)) and [docs](https://example.com/guide) now.';
  const out = presentPageText(content, 500);
  assert.equal(out.truncated, false);
  assert.doesNotMatch(out.text, /javascript:/);
  assert.match(out.text, /click me/);
  assert.match(out.text, /\[docs\]\(https:\/\/example\.com\/guide\)/);
});

test('image markup collapses to alt text', () => {
  const content = 'See ![diagram](/img/a.png) for detail.';
  const out = presentPageText(content, 500);
  assert.doesNotMatch(out.text, /!\[diagram\]/);
  assert.match(out.text, /diagram/);
});

test('unclosed fence is deterministic and bounded', () => {
  const content = `Intro paragraph here.\n\n\`\`\`js\nconst a = 1;\nmore code without end ${'x '.repeat(200)}`;
  const first = presentPageText(content, 300);
  const second = presentPageText(content, 300);
  assert.equal(first.text, second.text);
  assert.ok(first.text.length <= 300);
});

test('plain one-line text without terminators degrades at word boundary', () => {
  const content = `${'alpha beta gamma delta '.repeat(40)}`.trim();
  const out = presentPageText(content, 200);
  assert.ok(out.text.length <= 200);
  assert.match(out.text, MARKER_RE);
  assert.doesNotMatch(out.text.slice(0, out.text.indexOf('[truncated')), /[A-Za-z]$/);
});
