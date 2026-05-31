/**
 * auditService.js
 *
 * Append-only writer for the audit_logs table.  Used for events that
 * are NOT already covered by bom_snapshots (which already tracks
 * recipe edit history).  Covers: login events, user changes, pricing
 * formula changes, Odoo sync triggers, and quantity-calculation runs.
 *
 * Audit writes must NEVER break the main request — all failures are
 * logged and swallowed.
 */

const pool = require('../config/db');

/**
 * Insert an audit_logs row.
 *
 * @param {object}   entry
 * @param {number|null} entry.userId       - users.id of the actor (NULL for anonymous/system)
 * @param {string}      entry.actionType   - e.g. 'login_success', 'pricing_formula_update'
 * @param {string}     [entry.entity]      - affected entity type, e.g. 'user', 'pricing_formula'
 * @param {number}     [entry.entityId]    - affected row id
 * @param {string}     [entry.description] - human-readable summary
 * @param {object}     [entry.valueBefore] - JSON snapshot before change
 * @param {object}     [entry.valueAfter]  - JSON snapshot after change
 * @param {string}     [entry.ipAddress]   - source IP (INET)
 * @param {object}     [client]            - optional pg client for txn participation
 */
async function logAudit(entry, client) {
  const db = client || pool;
  try {
    await db.query(
      `INSERT INTO audit_logs
         (user_id, action_type, entity, entity_id, description,
          value_before, value_after, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.userId ?? null,
        entry.actionType,
        entry.entity ?? null,
        entry.entityId ?? null,
        entry.description ?? null,
        entry.valueBefore != null ? JSON.stringify(entry.valueBefore) : null,
        entry.valueAfter  != null ? JSON.stringify(entry.valueAfter)  : null,
        entry.ipAddress ?? null,
      ]
    );
  } catch (err) {
    console.error('[audit] Failed to write log:', err.message);
  }
}

/**
 * Resolve the client IP from the request, honouring X-Forwarded-For
 * when the app is behind a reverse proxy.  Returns null if it cannot
 * be determined (audit_logs.ip_address is nullable).
 */
function getIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const first = xff.toString().split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || null;
}

module.exports = { logAudit, getIp };
