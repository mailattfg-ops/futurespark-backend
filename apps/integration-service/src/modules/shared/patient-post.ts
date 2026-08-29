import http from 'http';
import https from 'https';
import { URL } from 'url';

/**
 * A JSON POST that is prepared to WAIT.
 *
 * Node's global `fetch` is undici, and undici aborts any request whose
 * response HEADERS have not arrived within five minutes (headersTimeout,
 * 300s). The transcribe call below holds ONE request open for the whole
 * transcribe-and-analyse pipeline, and the server says nothing until it is
 * done — so a class long enough to need more than five minutes of pipeline
 * died on every attempt as a bare "fetch failed", the retry clock burned to
 * FAILED, and the recording looked broken when only the clock was.
 *
 * Built on node:http rather than undici options because undici is not
 * importable here (Node bundles it but does not expose Agent), and adding a
 * dependency for one timeout number is not worth it.
 *
 * The timeout this DOES have is an idle one: it fires only after that long
 * with no bytes at all from the server, which for a respond-at-the-end
 * pipeline means "the response never started". That is a real hang, not a
 * long class — one hour of silence is the give-up point, far above any
 * legitimate pipeline and far below "wait forever on a dead socket".
 */
export interface PatientResponse {
  status: number;
  ok: boolean;
  /** The full response body, undecoded — JSON.parse it if you expect JSON. */
  text: string;
}

export const postJsonPatient = (
  url: string,
  payload: unknown,
  idleTimeoutMs = Number(process.env.INTERNAL_POST_IDLE_TIMEOUT_MS ?? 60 * 60 * 1000)
): Promise<PatientResponse> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    const lib = target.protocol === 'https:' ? https : http;

    const req = lib.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            text: Buffer.concat(chunks).toString('utf-8'),
          })
        );
        res.on('error', reject);
      }
    );

    req.setTimeout(idleTimeoutMs, () => {
      // Named cause, unlike "fetch failed": this message is what lands in
      // transcriptionError and what an operator reads in the panel.
      req.destroy(
        new Error(
          `No response from ${target.host} after ${Math.round(idleTimeoutMs / 60_000)} minutes of silence — ` +
            'the transcription service never answered this attempt.'
        )
      );
    });

    req.on('error', reject);
    req.end(body);
  });
