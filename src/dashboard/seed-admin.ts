import { z } from 'zod';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './auth/password.js';
import { DashboardDb, resolveDashboardDbPath } from './db.js';

const seedEnvSchema = z.object({
  ADMIN_EMAIL: z.string().email('ADMIN_EMAIL must be an email address'),
  ADMIN_PASSWORD: z.string().min(MIN_PASSWORD_LENGTH, `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

/**
 * Idempotently creates/updates the admin from ADMIN_EMAIL / ADMIN_PASSWORD (run by the deploy
 * workflow). The hash is only rewritten when the password actually changed; a changed
 * password logs out all sessions. TOTP enrolment is untouched.
 */
export async function seedAdmin(env: NodeJS.ProcessEnv, db: DashboardDb): Promise<string> {
  const parsed = seedEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = parsed.data;
  const existing = db.userByEmail(email);
  if (existing && (await verifyPassword(password, existing.password_hash))) {
    return `admin ${email} unchanged`;
  }
  const { created } = db.upsertUser(email, await hashPassword(password));
  const user = db.userByEmail(email)!;
  if (!created) db.deleteSessionsForUser(user.id);
  db.audit('deploy', created ? 'admin_created' : 'admin_password_changed', email);
  return `admin ${email} ${created ? 'created' : 'password updated'}`;
}

const isMain = process.argv[1]?.endsWith('seed-admin.js');
if (isMain) {
  const db = new DashboardDb(resolveDashboardDbPath(process.env));
  seedAdmin(process.env, db)
    .then((msg) => {
      process.stdout.write(`${msg}\n`);
      db.close();
    })
    .catch((err: unknown) => {
      process.stderr.write(`seed-admin failed: ${err instanceof Error ? err.message : String(err)}\n`);
      db.close();
      process.exit(1);
    });
}
