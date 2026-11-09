'use strict';

/**
 * Single sign-on from the staff portal (portal-generator).
 *
 * The portal signs a one-minute ticket (HS256 JWT) with a secret shared only with this
 * platform, and opens the platform at /#sso=<ticket>. The page posts the ticket to
 * /api/auth/sso; when it checks out, the user named in it gets an ordinary session, exactly
 * as if they had typed their password. The username/password login is untouched.
 */

const jwt = require('jsonwebtoken');

const ISSUER = 'apex-portal';
const MAX_TICKET_SECONDS = 120;

/** Ticket ids already used, kept until the ticket would have expired anyway: each ticket works once. */
class UsedTickets {
  constructor({ now = () => Date.now() } = {}) { this.ids = new Map(); this.now = now; }
  /** Marks the id used; false when it had been used before. */
  claim(jti, expSeconds) {
    this.sweep();
    if (this.ids.has(jti)) return false;
    this.ids.set(jti, expSeconds * 1000);
    return true;
  }
  sweep() { const now = this.now(); for (const [k, exp] of this.ids) if (exp < now) this.ids.delete(k); }
}

/**
 * Checks a portal ticket and returns its claims, or null when it is not one this platform
 * should accept: wrong signature, issuer or audience, expired, issued for longer than
 * MAX_TICKET_SECONDS, without a username or id, or already used.
 */
function verifyTicket(ticket, { secret, appId, used }) {
  if (!secret || typeof ticket !== 'string' || ticket.length > 4096) return null;
  let claims;
  try {
    claims = jwt.verify(ticket, secret, { algorithms: ['HS256'], issuer: ISSUER, audience: appId, clockTolerance: 30 });
  } catch {
    return null;
  }
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.jti !== 'string' || !claims.jti) return null;
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp - claims.iat > MAX_TICKET_SECONDS) return null;
  if (!used.claim(claims.jti, claims.exp)) return null;
  return claims;
}

module.exports = { UsedTickets, verifyTicket, ISSUER };
