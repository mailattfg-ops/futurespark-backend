/**
 * Self-check for Zoom instance-UUID encoding. Run:
 *   npx ts-node --transpile-only apps/integration-service/src/modules/zoom/recording/uuid-encode.check.ts
 * No network.
 *
 * Zoom's rule: a meeting UUID used as a path segment must be double
 * URL-encoded when it starts with "/" or contains "//", and single-encoded
 * otherwise. Get it wrong and the per-occurrence recording fetch 404s — which
 * would silently look like "this session has no recording".
 */
import assert from 'assert';
import { ZoomRecordingService } from './recording.service';

const enc = (u: string) => ZoomRecordingService.encodeInstanceUuid(u);

// Ordinary UUID: encoded once. "+" and "=" are the characters that matter.
assert.strictEqual(enc('abc123=='), 'abc123%3D%3D', 'plain uuid encoded once');
assert.strictEqual(enc('4444AAAiAAA='), '4444AAAiAAA%3D', 'trailing = encoded once');
assert.strictEqual(enc('a+b/c'), 'a%2Bb%2Fc', 'a single slash inside is still one pass');

// Leading slash → double encoded, so the %2F itself becomes %252F.
assert.strictEqual(enc('/ajXp112QmuoKj4854875='), '%252FajXp112QmuoKj4854875%253D', 'leading slash double encoded');

// Embedded double slash → double encoded.
assert.strictEqual(enc('abc//def'), 'abc%252F%252Fdef', 'double slash double encoded');

// Never emits a raw slash, which is what breaks the path.
for (const u of ['/x/', 'a//b', 'plain', 'we+ird/']) {
  assert.ok(!enc(u).includes('/'), `no raw slash survives encoding of "${u}"`);
}

console.log('zoom uuid encoding: 9/9 checks passed');
