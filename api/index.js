// Vercel serverless entry point.
//
// The vercel.json `routes` send EVERY request to this function, and
// legacy routing preserves the original URL (e.g. /api/health or /login)
// in req.url. The Express app therefore matches its /api/* routes
// directly, and for any non-API path it serves the built React SPA
// (client/dist) via the static + fallback handlers already wired in
// src/app.js. One function = the whole app.
module.exports = require('../src/app');
