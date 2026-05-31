const express = require('express');
const pool    = require('../config/db');

const router = express.Router();

// GET /categories — list all categories (Odoo-synced + locally created)
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, odoo_id, name
     FROM   categories
     ORDER  BY name`
  );
  res.json(rows);
});

module.exports = router;
