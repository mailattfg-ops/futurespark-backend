/**
 * The machine credential for service-to-service calls into auth-service.
 *
 * The internal endpoints used to treat the ABSENCE of credentials as proof of
 * being a machine — which meant any anonymous caller who could reach the port
 * was one (finding S1-00). They now require this key. Sent only when
 * configured, so a deployment that has not set the key yet behaves exactly as
 * before while the warning in auth-service's log says what is still open.
 */
export const internalKeyHeader = (): Record<string, string> =>
  process.env.INTERNAL_API_KEY ? { 'x-internal-key': process.env.INTERNAL_API_KEY } : {};
