import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (what = 'Forbidden') => new HttpError(403, what);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed', issues: err.issues });
  const code = (err as { code?: string })?.code;
  if (code === 'P2025') return res.status(404).json({ error: 'Not found' });
  if (code === 'P2002') return res.status(409).json({ error: 'Already exists' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
