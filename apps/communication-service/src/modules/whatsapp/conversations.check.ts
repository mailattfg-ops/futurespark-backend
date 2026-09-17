/**
 * Self-check for the inbox's pure rules.
 *
 *   npx ts-node --transpile-only src/modules/whatsapp/conversations.check.ts
 *
 * Nothing here touches the database or Meta: what is worth pinning down is the
 * thread key (which end of a row is the customer), phone normalisation, and
 * the media-file guard that keeps a poisoned row from reading arbitrary files.
 */
import assert from 'assert';
import { counterpartOf, normalisePhone } from './conversations.service';
import { baseMime, extensionFor, isMediaType, isSafeMediaFile, mimeForFile } from './media';

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  void name;
};

// ── phone normalisation ──────────────────────────────────────────────────────
check('strips punctuation and spaces', () => {
  assert.strictEqual(normalisePhone('+91 98765 43210'), '919876543210');
  assert.strictEqual(normalisePhone('(919) 876-5432'), '9198765432');
});

check('empty and undefined-ish inputs are empty, not crashes', () => {
  assert.strictEqual(normalisePhone(''), '');
  assert.strictEqual(normalisePhone(undefined as any), '');
});

// ── thread key ───────────────────────────────────────────────────────────────
check('inbound threads on the sender', () => {
  assert.strictEqual(
    counterpartOf({ from: '919876543210', to: 'SYSTEM', direction: 'INBOUND' }),
    '919876543210'
  );
});

check('outbound threads on the recipient', () => {
  assert.strictEqual(
    counterpartOf({ from: 'SYSTEM', to: '+91 98765 43210', direction: 'OUTBOUND' }),
    '919876543210'
  );
});

check('both directions of one conversation share a key', () => {
  const inbound = counterpartOf({ from: '+919876543210', to: 'SYSTEM', direction: 'INBOUND' });
  const outbound = counterpartOf({ from: '15550001111', to: '919876543210', direction: 'OUTBOUND' });
  assert.strictEqual(inbound, outbound);
});

// ── media types ──────────────────────────────────────────────────────────────
check('audio and images are media, text and button are not', () => {
  assert.ok(isMediaType('audio'));
  assert.ok(isMediaType('image'));
  assert.ok(isMediaType('document'));
  assert.ok(!isMediaType('text'));
  assert.ok(!isMediaType('button'));
  assert.ok(!isMediaType('interactive'));
});

check('a WhatsApp voice note keeps an ogg extension', () => {
  assert.strictEqual(baseMime('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.strictEqual(extensionFor('audio/ogg; codecs=opus'), 'ogg');
  assert.strictEqual(mimeForFile('abc123.ogg'), 'audio/ogg');
});

check('an unknown type still stores, as bin', () => {
  assert.strictEqual(extensionFor('application/x-weird'), 'bin');
  assert.strictEqual(mimeForFile('abc.bin'), 'application/octet-stream');
});

// ── path traversal guard ─────────────────────────────────────────────────────
check('only plain <id>.<ext> names are servable', () => {
  assert.ok(isSafeMediaFile('wamid_ABC-123.ogg'));
  assert.ok(!isSafeMediaFile('../../.env'));
  assert.ok(!isSafeMediaFile('a/b.ogg'));
  assert.ok(!isSafeMediaFile('a\\b.ogg'));
  assert.ok(!isSafeMediaFile('noextension'));
  assert.ok(!isSafeMediaFile('.env'));
});

console.log(`conversations: ${passed}/${passed} checks passed`);
