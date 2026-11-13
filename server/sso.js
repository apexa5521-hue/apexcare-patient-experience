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
const PLATFORM_ISSUER = 'apexcare-platform';
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
function verifyTicket(ticket, { secret, publicKey, appId, used }) {
  if ((!secret && !publicKey) || typeof ticket !== 'string' || ticket.length > 4096) return null;
  // the operations platform signs with its organization's private key (ES256); the old portal with a shared secret (HS256)
  const ways = [];
  if (publicKey) ways.push([publicKey, { algorithms: ['ES256'], issuer: PLATFORM_ISSUER }]);
  if (secret) ways.push([secret, { algorithms: ['HS256'], issuer: ISSUER }]);
  let claims = null;
  for (const [key, opts] of ways) {
    try { claims = jwt.verify(ticket, key, { ...opts, audience: appId, clockTolerance: 30 }); break; } catch { /* try the next way */ }
  }
  if (!claims) return null;
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.jti !== 'string' || !claims.jti) return null;
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp - claims.iat > MAX_TICKET_SECONDS) return null;
  if (!used.claim(claims.jti, claims.exp)) return null;
  return claims;
}

/** A PEM public key pasted into an environment variable: real line breaks, or written as \n. */
function readPublicKey(value) {
  const v = String(value || '').trim().replace(/\\n/g, '\n');
  return v.includes('BEGIN PUBLIC KEY') ? v : '';
}

module.exports = { UsedTickets, verifyTicket, readPublicKey, ISSUER, PLATFORM_ISSUER };
