import { Router, type Request, type Response } from 'express';
import { decryptSecret, encryptSecret } from '../../store/crypto.js';
import { DUMMY_HASH_PROMISE, verifyPassword } from '../auth/password.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { requireCsrf, requireFullAuth } from '../auth/session.js';
import { generateTotpSecret, otpauthUri, qrSvg, verifyTotp } from '../auth/totp.js';
import { clientIp, renderPage, type RouteContext } from '../context.js';
import { loginPage, totpPage, totpSetupPage } from '../views/auth-pages.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
const GENERIC_LOGIN_ERROR = 'Onjuiste inloggegevens.';

export function authRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { db, sessions, totpKey } = ctx;
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const totpLimiter = new RateLimiter(10, 15 * 60 * 1000);

  const failAttempt = (userId: number, failedSoFar: number): void => {
    const lock = failedSoFar + 1 >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
    db.recordFailedLogin(userId, lock);
  };
  const isLocked = (lockedUntil: string | null): boolean =>
    lockedUntil !== null && Date.parse(lockedUntil) > Date.now();

  router.get('/login', (_req, res) => {
    if (res.locals.auth?.session.stage === 'full') return res.redirect(303, '/');
    renderPage(res, { title: 'Inloggen', body: loginPage() });
  });

  router.post('/login', async (req: Request, res: Response) => {
    const tooMany = !loginLimiter.take(clientIp(req));
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = email ? db.userByEmail(email) : undefined;
    // Always run scrypt so response time does not reveal whether the email exists.
    const valid = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH_PROMISE));

    if (tooMany || !user || isLocked(user.locked_until) || !valid) {
      if (user && !valid && !isLocked(user.locked_until)) failAttempt(user.id, user.failed_attempts);
      db.audit(email || 'onbekend', 'login_failed', null, { ip: clientIp(req) });
      const message = tooMany ? 'Te veel pogingen. Probeer het later opnieuw.' : GENERIC_LOGIN_ERROR;
      return renderPage(res, { title: 'Inloggen', body: loginPage(message) }, tooMany ? 429 : 401);
    }

    sessions.start(req, res, user.id, user.totp_enabled ? 'verify_totp' : 'enroll_totp');
    res.redirect(303, user.totp_enabled ? '/login/totp' : '/login/totp-setup');
  });

  router.get('/login/totp', (_req, res) => {
    const auth = res.locals.auth;
    if (auth?.session.stage !== 'verify_totp') return res.redirect(303, '/login');
    renderPage(res, { title: 'Verificatiecode', body: totpPage(auth.session.csrf_token) });
  });

  router.post('/login/totp', requireCsrf, (req, res) => {
    const auth = res.locals.auth;
    if (auth?.session.stage !== 'verify_totp' || !auth.user.totp_secret) return res.redirect(303, '/login');
    const { user } = auth;
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const tooMany = !totpLimiter.take(clientIp(req));
    const ok =
      !tooMany &&
      !isLocked(user.locked_until) &&
      verifyTotp(decryptSecret(user.totp_secret!, totpKey, `user:${user.id}`), code);
    if (!ok) {
      if (!tooMany && !isLocked(user.locked_until)) failAttempt(user.id, user.failed_attempts);
      db.audit(user.email, 'totp_failed', null, { ip: clientIp(req) });
      if (isLocked(db.userById(user.id)?.locked_until ?? null)) {
        sessions.destroy(req, res);
        return renderPage(res, { title: 'Inloggen', body: loginPage(GENERIC_LOGIN_ERROR) }, 401);
      }
      return renderPage(res, { title: 'Verificatiecode', body: totpPage(auth.session.csrf_token, 'Ongeldige code.') }, 401);
    }
    db.resetFailedLogins(user.id);
    sessions.start(req, res, user.id, 'full');
    db.audit(user.email, 'login', null, { ip: clientIp(req) });
    res.redirect(303, '/');
  });

  const pendingSecret = (res: Response): string => {
    const auth = res.locals.auth!;
    const aad = `pending:${auth.sessionIdHash}`;
    if (auth.session.pending_totp_secret) {
      return decryptSecret(auth.session.pending_totp_secret, totpKey, aad);
    }
    const secret = generateTotpSecret();
    db.updateSession(auth.sessionIdHash, { pending_totp_secret: encryptSecret(secret, totpKey, aad) });
    return secret;
  };

  router.get('/login/totp-setup', (_req, res) => {
    const auth = res.locals.auth;
    if (auth?.session.stage !== 'enroll_totp') return res.redirect(303, auth ? '/' : '/login');
    const secret = pendingSecret(res);
    renderPage(res, {
      title: 'Tweestapsverificatie',
      body: totpSetupPage(auth.session.csrf_token, qrSvg(otpauthUri(secret, auth.user.email)), secret),
    });
  });

  router.post('/login/totp-setup', requireCsrf, (req, res) => {
    const auth = res.locals.auth;
    if (auth?.session.stage !== 'enroll_totp') return res.redirect(303, '/login');
    const secret = pendingSecret(res);
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!totpLimiter.take(clientIp(req)) || !verifyTotp(secret, code)) {
      return renderPage(
        res,
        {
          title: 'Tweestapsverificatie',
          body: totpSetupPage(auth.session.csrf_token, qrSvg(otpauthUri(secret, auth.user.email)), secret, 'Ongeldige code, probeer opnieuw.'),
        },
        401,
      );
    }
    db.setTotp(auth.user.id, encryptSecret(secret, totpKey, `user:${auth.user.id}`), true);
    db.resetFailedLogins(auth.user.id);
    // Log out every other session: they were authenticated with the previous second factor.
    db.deleteSessionsForUser(auth.user.id);
    sessions.start(req, res, auth.user.id, 'full');
    db.audit(auth.user.email, 'totp_enrolled', null, { ip: clientIp(req) });
    res.redirect(303, '/');
  });

  router.post('/settings/totp-reset', requireFullAuth, requireCsrf, (req, res) => {
    const auth = res.locals.auth!;
    if (req.body?.confirm !== 'on') return res.redirect(303, '/settings');
    db.updateSession(auth.sessionIdHash, { stage: 'enroll_totp', pending_totp_secret: null });
    db.audit(auth.user.email, 'totp_reset_started', null);
    res.redirect(303, '/login/totp-setup');
  });

  router.post('/logout', requireCsrf, (req, res) => {
    if (res.locals.auth) db.audit(res.locals.auth.user.email, 'logout', null);
    sessions.destroy(req, res);
    res.redirect(303, '/login');
  });

  return router;
}
