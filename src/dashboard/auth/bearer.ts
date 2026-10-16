import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Express middleware: `Authorization: Bearer <token>` with a timing-safe compare, else 401 JSON. */
export function bearer(token: string) {
  const expected = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
    const provided = Buffer.from(match?.[1] ?? '');
    const ok = provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!ok) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }
    next();
  };
}
