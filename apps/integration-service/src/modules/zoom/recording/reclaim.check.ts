/**
 * Self-check for the local-video reclaim guard. Run:
 *   npx ts-node --transpile-only apps/integration-service/src/modules/zoom/recording/reclaim.check.ts
 * Pure logic — no disk, no S3, no database.
 *
 * This guards a DELETE path: after a video is confirmed in the bucket, the
 * local copy is removed. The one thing that must never happen is deleting the
 * S3 key itself or a relative/remote reference instead of a real local file.
 */
import assert from 'assert';
import { canReclaimLocalVideo } from './recording.service';

const KEY = 'recordings/video/abc123_Session.mp4';

// A real absolute local file may be reclaimed.
assert.strictEqual(
  canReclaimLocalVideo('/home/ubuntu/futurespark-backend/apps/integration-service/downloads/video/x.mp4', KEY),
  true,
  'an absolute local path is reclaimable',
);

// The S3 key itself must NEVER be deleted.
assert.strictEqual(canReclaimLocalVideo(KEY, KEY), false, 'the S3 key is never treated as a local file');

// A relative path (which is how an S3 key looks) is never a local file to delete.
assert.strictEqual(canReclaimLocalVideo('recordings/video/other.mp4', KEY), false, 'a relative/remote reference is not reclaimed');

// Nothing to delete when there is no path.
assert.strictEqual(canReclaimLocalVideo(null, KEY), false, 'null is not reclaimable');
assert.strictEqual(canReclaimLocalVideo(undefined, KEY), false, 'undefined is not reclaimable');
assert.strictEqual(canReclaimLocalVideo('', KEY), false, 'empty string is not reclaimable');

console.log('video reclaim guard: 6/6 checks passed');
