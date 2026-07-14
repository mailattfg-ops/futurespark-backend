export interface MigrationStatus {
  serviceName: string;
  databaseUrl: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  error?: string;
}

export function logMigrationStatus(status: MigrationStatus): void {
  console.log(
    `[Migration] [${status.serviceName}] Status: ${status.status}${
      status.error ? ` - Error: ${status.error}` : ''
    }`
  );
}
