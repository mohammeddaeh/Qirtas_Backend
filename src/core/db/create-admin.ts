import readline from 'node:readline';
import { hashPassword } from '../security/password.js';
import { eq } from 'drizzle-orm';

import { db, pool } from './client.js';
import { usersTable } from '../../features/identity/schemas/users.schema.js';
import { rolesTable } from '../../features/identity/schemas/roles.schema.js';
import { userRoleAssignmentsTable } from '../../features/identity/schemas/user-role-assignments.schema.js';
import { logger } from '../logger/logger.js';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

async function main() {
  const email = await ask('Enter admin email: ');
  const password = await ask('Enter admin password: ');

  if (!email || !password) {
    throw new Error('Email and password are required');
  }

  // ✅ check if user already exists (احترافي)
  const existingUser = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existingUser[0]) {
    throw new Error('User already exists');
  }

const hashedPassword = await hashPassword(password);
  // ✅ insert user
  const result = await db
    .insert(usersTable)
    .values({
      email,
      password_hash: hashedPassword,
      first_name: 'Super',
      last_name: 'Admin',
      phone: '0000000000',
      status: 'active',
    })
    .returning();

  const user = result[0];

  // 🔥 الحل الحقيقي للخطأ
  if (!user) {
    throw new Error('User creation failed');
  }

  // ✅ get role
  const roleRows = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.name, 'Super Admin'))
    .limit(1);

  const role = roleRows[0];

  if (!role) {
    throw new Error('Super Admin role not found. Run seed first.');
  }

  // ✅ assign role
  await db.insert(userRoleAssignmentsTable).values({
    user_id: user.id,
    role_id: role.id,
  });

  logger.info(`✅ Super Admin created: ${email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit());