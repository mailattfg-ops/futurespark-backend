export interface PostgresConnectionConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

export function parseConnectionString(url: string): PostgresConnectionConfig {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '5432'),
      user: parsed.username,
      password: parsed.password,
      database: parsed.pathname.substring(1),
      ssl: parsed.searchParams.get('sslmode') === 'require',
    };
  } catch (error) {
    return {};
  }
}
