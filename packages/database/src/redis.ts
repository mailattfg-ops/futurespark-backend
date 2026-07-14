export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

export function parseRedisConnectionString(url: string): RedisConnectionConfig {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379'),
      password: parsed.password || undefined,
      db: parsed.pathname ? parseInt(parsed.pathname.substring(1)) || 0 : 0,
    };
  } catch (error) {
    return { host: 'localhost', port: 6379 };
  }
}
