import dotenv from 'dotenv';
import path from 'path';

/**
 * Side-effect module: loads environment variables.
 *
 * This MUST be the first import in server.ts. TypeScript emits CommonJS
 * `require` calls in import order, so calling dotenv.config() in the body of
 * server.ts runs *after* `./app` — and its whole module graph — has already
 * been loaded. Any module-scope `process.env.X` read (e.g. GROQ_API_KEY in
 * GroqTranscriptionService) would then see undefined.
 */

// Root backend/.env — shared DB URLs, JWT secrets, INTERNAL_HMAC_KEY, GROQ_API_KEY.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
// Service-specific .env — PORT, NODE_ENV. Does not override keys already set above.
dotenv.config();
