import { getUserBySessionId } from '../db/repos/sessions.js';

export function requireUser(req, res, next) {
  const sid = req.signedCookies?.sid || req.cookies?.sid;
  const user = getUserBySessionId(sid);
  if (!user) {
    return res.status(401).json({ detail: 'Not authenticated' });
  }
  req.user = user;
  req.sessionId = sid;
  next();
}

export function attachUser(req, _res, next) {
  const sid = req.signedCookies?.sid || req.cookies?.sid;
  const user = getUserBySessionId(sid);
  if (user) {
    req.user = user;
    req.sessionId = sid;
  }
  next();
}
