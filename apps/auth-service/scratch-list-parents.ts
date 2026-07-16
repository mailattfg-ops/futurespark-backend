import { PrismaClient } from './prisma/client';

const prisma = new PrismaClient();

async function main() {
  const parents = await prisma.parentAccount.findMany({
    include: {
      profiles: true,
      students: true
    }
  });
  console.log("Parent Accounts:");
  console.log(JSON.stringify(parents, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
