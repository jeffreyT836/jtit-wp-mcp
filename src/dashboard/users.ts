import { z } from 'zod';
import { WpError, sanitizeMessage } from '../wp/errors.js';
import { roleSlugSchema, usernameSchema, type NewUser } from '../wp/users.js';
import { plainText } from './updates.js';

export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

/**
 * Create-user form. Field names are deliberately not `username`/`password`: password
 * managers would autofill the dashboard's own login into them (see tasks/lessons.md).
 */
const newUserFormSchema = z
  .object({
    new_user_login: usernameSchema,
    new_user_email: z.email('ongeldig e-mailadres').max(100),
    new_user_role: roleSlugSchema,
    new_user_first: z.string().max(100),
    new_user_last: z.string().max(100),
    new_user_pass: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `wachtwoord moet minstens ${MIN_PASSWORD_LENGTH} tekens zijn`)
      .max(MAX_PASSWORD_LENGTH, `wachtwoord mag hoogstens ${MAX_PASSWORD_LENGTH} tekens zijn`)
      // WordPress rejects a backslash in passwords.
      .refine((p) => !p.includes('\\'), 'wachtwoord mag geen \\ bevatten')
      .refine((p) => p.trim() === p, 'wachtwoord mag niet met een spatie beginnen of eindigen'),
  })
  .refine((f) => !f.new_user_pass.toLowerCase().includes(f.new_user_login.toLowerCase()), {
    message: 'wachtwoord mag de gebruikersnaam niet bevatten',
    path: ['new_user_pass'],
  });

const FIELD_LABELS: Record<string, string> = {
  new_user_login: 'Gebruikersnaam',
  new_user_email: 'E-mailadres',
  new_user_role: 'Rol',
  new_user_first: 'Voornaam',
  new_user_last: 'Achternaam',
  new_user_pass: 'Wachtwoord',
};

/** Non-secret form values, for re-rendering the form after an error (never the password). */
export interface NewUserFormValues {
  username: string;
  email: string;
  role: string;
  firstName: string;
  lastName: string;
}

export function newUserFormValues(body: Record<string, unknown>): NewUserFormValues {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  return {
    username: s('new_user_login'),
    email: s('new_user_email'),
    role: s('new_user_role'),
    firstName: s('new_user_first'),
    lastName: s('new_user_last'),
  };
}

export function parseNewUser(body: Record<string, unknown>): { ok: true; user: NewUser } | { ok: false; error: string } {
  const values = newUserFormValues(body);
  const parsed = newUserFormSchema.safeParse({
    new_user_login: values.username,
    new_user_email: values.email,
    new_user_role: values.role,
    new_user_first: values.firstName,
    new_user_last: values.lastName,
    new_user_pass: typeof body.new_user_pass === 'string' ? body.new_user_pass : '',
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${FIELD_LABELS[String(i.path[0])] ?? 'Formulier'}: ${i.message}`).join('; '),
    };
  }
  const f = parsed.data;
  return {
    ok: true,
    user: {
      username: f.new_user_login,
      email: f.new_user_email,
      role: f.new_user_role,
      password: f.new_user_pass,
      first_name: f.new_user_first || undefined,
      last_name: f.new_user_last || undefined,
    },
  };
}

const USER_ERRORS: Record<string, string> = {
  existing_user_login: 'Er bestaat al een gebruiker met deze gebruikersnaam.',
  existing_user_email: 'Er bestaat al een gebruiker met dit e-mailadres.',
  rest_invalid_param: 'WordPress heeft een van de velden afgewezen.',
  rest_user_invalid_role: 'Deze rol bestaat niet op de site, of je mag hem niet toekennen.',
  rest_cannot_create_user: 'De gekoppelde WordPress-gebruiker mag geen gebruikers aanmaken.',
  rest_user_cannot_delete: 'De gekoppelde WordPress-gebruiker mag deze gebruiker niet verwijderen.',
  rest_cannot_delete: 'Deze gebruiker kan niet worden verwijderd (op multisite kan dat niet via de REST-API).',
  rest_user_invalid_reassign: 'De gebruiker om de inhoud aan toe te wijzen bestaat niet.',
  rest_user_invalid_id: 'Deze gebruiker bestaat niet (meer).',
};

/** User-facing Dutch message for a failed user action. Never contains the password. */
export function userErrorMessage(err: unknown): string {
  if (err instanceof WpError) return USER_ERRORS[err.code] ?? plainText(err.message);
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('refusing to delete the account')) {
    return 'Dit is de gebruiker waarmee het dashboard inlogt; die kan hier niet worden verwijderd.';
  }
  return plainText(sanitizeMessage(message));
}
