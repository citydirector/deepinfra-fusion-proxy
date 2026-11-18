/**
 * keyOf(): the per-session key the proxy routes and locks on.
 *
 * DSH direct sends `prompt_cache_key`; a gateway in front of the proxy
 * (magpie) forwards the body without it, and the ladder must still land on one
 * key per conversation instead of collapsing everything into `default`.
 *
 * The function lives inside the standalone core, so this test extracts it
 * rather than starting the server.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const from = source.indexOf('const SESSION_HEADERS');
const to = source.indexOf('function bodyForMode');
assert.ok(from > 0 && to > from, 'keyOf block not found in server.js');
const factory = new Function(source.slice(from, to) + '\nreturn { keyOf, SESSION_HEADERS };');
const {keyOf} = factory();

const chat = (...turns) => ({model: 'deepseek-ai/DeepSeek-V4.1-Flash', messages: turns.map((text) => ({role: 'user', content: text}))});

test('prompt_cache_key wins over everything else', () => {
  const body = {...chat('hi'), prompt_cache_key: 'session-abc'};
  assert.equal(keyOf(body, {'x-session-id': 'header-id'}), 'session-abc');
});

test('a session header stands in when the body has no prompt_cache_key', () => {
  assert.equal(keyOf(chat('hi'), {'x-dfusion-session': ' df-1 '}), 'df-1');
  assert.equal(keyOf(chat('hi'), {'x-magpie-session': 'x', 'x-conversation-id': 'conv-9'}), 'conv-9');
  assert.equal(keyOf(chat('hi'), {'x-session-id': 'a'.repeat(200)}).length, 64);
});

test('a body session id is used next', () => {
  assert.equal(keyOf({...chat('hi'), session_id: 's-1'}, {}), 's-1');
  assert.equal(keyOf({...chat('hi'), metadata: {session_id: 's-2'}}, {}), 's-2');
  assert.equal(keyOf({...chat('hi'), user: 'user-3'}, {}), 'user-3');
});

test('the opening turn gives one stable key per conversation', () => {
  const first = keyOf(chat('hello there'), {});
  const same = keyOf({model: 'deepseek-ai/DeepSeek-V4.1-Flash', messages: [
    {role: 'system', content: 'you are helpful'},
    {role: 'user', content: 'hello there'},
    {role: 'assistant', content: 'hi'},
  ]}, {});
  assert.match(first, /^conv-[0-9a-z]+$/);
  assert.equal(first, same, 'later turns of one conversation share the key');
  assert.notEqual(first, keyOf(chat('different question'), {}));
  assert.notEqual(first, keyOf({...chat('hello there'), model: 'deepseek-ai/DeepSeek-V4-Pro'}, {}));
});

test('nothing usable falls back to the global key', () => {
  assert.equal(keyOf({}, {}), 'default');
  assert.equal(keyOf(undefined, undefined), 'default');
  assert.equal(keyOf({messages: []}, {}), 'default');
});
