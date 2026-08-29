import { db } from '../apps/auth-service/src/database/datasource';
import { hashPassword } from '@futurespark/authentication';
import { logger } from '@futurespark/logger';

async function seedAdminCredentials() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@finquo.ai').toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'AdminPassword123!';

  logger.info(`Seeding/updating ADMIN credentials for ${adminEmail}...`);

  try {
    // 1. Ensure ADMIN Role exists
    let adminRole = await db.role.findFirst({
      where: {
        name: {
          equals: 'ADMIN',
          mode: 'insensitive',
        },
      },
    });

    if (!adminRole) {
      adminRole = await db.role.create({
        data: {
          name: 'ADMIN',
          description: 'Administrator role with full system access',
          permissions: ['*'],
        },
      });
      logger.info(`Created ADMIN role with ID: ${adminRole.id}`);
    } else {
      logger.info(`Found existing ADMIN role with ID: ${adminRole.id}`);
    }

    // 2. Hash password
    const passwordHash = hashPassword(adminPassword);

    // 3. Create or Update Admin User
    const existingAdmin = await db.user.findFirst({
      where: {
        email: {
          equals: adminEmail,
          mode: 'insensitive',
        },
      },
    });

    let adminUser;
    if (existingAdmin) {
      adminUser = await db.user.update({
        where: { id: existingAdmin.id },
        data: {
          passwordHash,
          roleId: adminRole.id,
          isActive: true,
          firstName: existingAdmin.firstName || 'Admin',
          lastName: existingAdmin.lastName || 'User',
        },
      });
      logger.info(`Updated existing ADMIN user (${adminEmail}).`);
    } else {
      adminUser = await db.user.create({
        data: {
          email: adminEmail,
          passwordHash,
          roleId: adminRole.id,
          firstName: 'Admin',
          lastName: 'User',
          isActive: true,
          requiresFtlReset: false,
        },
      });
      logger.info(`Created new ADMIN user (${adminEmail}).`);
    }

    console.log('\n==================================================');
    console.log('  ADMIN CREDENTIALS READY:');
    console.log(`  Email:    ${adminEmail}`);
    console.log(`  Password: ${adminPassword}`);
    console.log(`  Role:     ${adminRole.name}`);
    console.log('==================================================\n');
  } catch (error: any) {
    logger.error(`Error setting up ADMIN credentials: ${error.message}`);
    console.error(error);
  } finally {
    await db.$disconnect();
  }
}

seedAdminCredentials();
