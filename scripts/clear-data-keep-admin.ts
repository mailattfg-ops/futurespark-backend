import { db } from '../apps/auth-service/src/database/datasource';
import { logger } from '@futurespark/logger';

async function clearDataKeepAdmin() {
  logger.info('Starting database cleanup (retaining ADMIN credentials and core curriculum schema)...');
  const client = db as any;

  try {
    // 1. Identify Admin Roles & Users to keep
    let adminRoleIds: string[] = [];
    try {
      const adminRoles = await db.role.findMany({
        where: {
          name: {
            contains: 'ADMIN',
            mode: 'insensitive',
          },
        },
      });
      adminRoleIds = adminRoles.map((r) => r.id);
      const adminUsers = await db.user.findMany({
        where: {
          roleId: {
            in: adminRoleIds,
          },
        },
        select: { id: true, email: true },
      });
      logger.info(`Found ${adminUsers.length} ADMIN user(s): ${adminUsers.map((u) => u.email).join(', ')}`);
    } catch (e: any) {
      logger.warn(`Could not query ADMIN roles/users yet: ${e.message}`);
    }

    // List of models to clear in order of foreign-key dependency
    const modelsToClear = [
      'classDoubt',
      'sessionReport',
      'scheduledClass',
      'enrollment',
      'student',
      'parentProfile',
      'parentAccount',
      'mentorSchedule',
      'schedulerGroup',
      'refreshToken',
      'pilotLead',
      'lead',
      'auditLog',
      'errorLog',
      'aiUsage',
    ];

    for (const modelName of modelsToClear) {
      if (client[modelName] && typeof client[modelName].deleteMany === 'function') {
        try {
          const res = await client[modelName].deleteMany({});
          logger.info(`Cleared ${res.count ?? 0} records from ${modelName}.`);
        } catch (err: any) {
          logger.warn(`Could not clear ${modelName}: ${err.message}`);
        }
      }
    }

    // Delete non-ADMIN users
    if (client.user && typeof client.user.deleteMany === 'function') {
      try {
        const res = await client.user.deleteMany({
          where: adminRoleIds.length > 0 ? { roleId: { notIn: adminRoleIds } } : { role: { isNot: { name: 'ADMIN' } } },
        });
        logger.info(`Cleared ${res.count ?? 0} non-ADMIN user records.`);
      } catch (err: any) {
        logger.warn(`Could not clear non-ADMIN users: ${err.message}`);
      }
    }

    logger.info('Database cleanup script finished successfully!');
  } catch (error: any) {
    logger.error(`Error during data cleanup: ${error.message}`);
  } finally {
    try {
      await db.$disconnect();
    } catch (e) {}
  }
}

clearDataKeepAdmin();
