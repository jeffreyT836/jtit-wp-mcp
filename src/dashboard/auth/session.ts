import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DashboardDb, SessionRow, SessionStage, UserRow } from '../db.js';

export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
export const IDLE_TTL_MS = 60 * 60 * 1000;

export interface AuthState {
  session: SessionRow;
  sessionIdHash: string;
  user: UserRow;
}

declare module 'express-serve-static-core' {
  interface Locals {
    auth?: AuthState;
  }
}

const hashId = (id: string): string => createHash('sha256').update(id).digest('hex');

export function cookieName(secure: boolean): string {
  // The __Host- prefix makes browsers refuse the cookie unless Secure, path=/ and no Domain.
  return secure ? '__Host-session' : 'session';
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export class SessionManager {
  constructor(
    private readonly db: DashboardDb,
    private readonly secure: boolean,
  ) {}

  /** Creates a new session (rotating any existing one) and sets the cookie. */
  start(req: Request, res: Response, userId: number, stage: SessionStage): void {
    const previous = readCookie(req, cookieName(this.secure));
    if (previous) this.db.deleteSession(hashId(previous));
    const id = randomBytes(32).toString('base64url');
    this.db.createSession({
      id_hash: hashId(id),
      user_id: userId,
      stage,
      csrf_token: randomBytes(32).toString('base64url'),
      pending_totp_secret: null,
    });
    res.cookie(cookieName(this.secure), id, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: '/',
      maxAge: ABSOLUTE_TTL_MS,
    });
  }

  destroy(req: Request, res: Response): void {
    const id = readCookie(req, cookieName(this.secure));
    if (id) this.db.deleteSession(hashId(id));
    res.clearCookie(cookieName(this.secure), { path: '/', secure: this.secure, sameSite: 'strict', httpOnly: true });
  }

  /** Middleware: loads a valid, non-expired session into `res.locals.auth`. */
  load() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const id = readCookie(req, cookieName(this.secure));
      if (id) {
        const idHash = hashId(id);
        const session = this.db.session(idHash);
        const now = Date.now();
        const expired =
          !session ||
          now - Date.parse(session.created_at) > ABSOLUTE_TTL_MS ||
          now - Date.parse(session.last_seen_at) > IDLE_TTL_MS;
        const user = session && !expired ? this.db.userById(session.user_id) : undefined;
        if (session && user) {
          this.db.updateSession(idHash, { last_seen_at: new Date(now).toISOString() });
          res.locals.auth = { session, sessionIdHash: idHash, user };
        } else if (session) {
          this.db.deleteSession(idHash);
        }
      }
      next();
    };
  }
}

/** Only lets fully authenticated (password + TOTP) sessions through; others go to the right step. */
export function requireFullAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = res.locals.auth;
  if (!auth) {
    res.redirect(303, '/login');
    return;
  }
  if (auth.session.stage === 'enroll_totp') {
    res.redirect(303, '/login/totp-setup');
    return;
  }
  if (auth.session.stage === 'verify_totp') {
    res.redirect(303, '/login/totp');
    return;
  }
  next();
}

/** Rejects state-changing requests whose `_csrf` field does not match the session's token. */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const expected = res.locals.auth?.session.csrf_token;
  const provided = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
  const ok =
    expected !== undefined &&
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    res.status(403).send('Ongeldig of verlopen formulier. Herlaad de pagina en probeer opnieuw.');
    return;
  }
  next();
}
