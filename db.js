const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;

function rowToClient(r) {
  return { id: r.id, name: r.name, createdAt: r.created_at };
}
function rowToTx(r) {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    date: r.date,
    tipo: r.tipo,
    usd: Number(r.usd),
    taxa: Number(r.taxa),
    brl: Number(r.brl),
    obs: r.obs || '',
    createdAt: r.created_at,
  };
}

let impl;

if (DATABASE_URL) {
  // Production: PostgreSQL (e.g. Neon). Data persists across deploys/restarts.
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      date TEXT NOT NULL,
      tipo TEXT NOT NULL,
      usd DOUBLE PRECISION NOT NULL,
      taxa DOUBLE PRECISION NOT NULL,
      brl DOUBLE PRECISION NOT NULL,
      obs TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  })();

  impl = {
    ready,
    async listClients() {
      const r = await pool.query('SELECT * FROM clients ORDER BY name ASC');
      return r.rows.map(rowToClient);
    },
    async addClient(name) {
      const id = crypto.randomUUID();
      const r = await pool.query(
        'INSERT INTO clients (id, name) VALUES ($1, $2) RETURNING *',
        [id, name]
      );
      return rowToClient(r.rows[0]);
    },
    async deleteClient(id) {
      await pool.query('DELETE FROM clients WHERE id = $1', [id]);
    },
    async listTransactions() {
      const r = await pool.query(
        'SELECT * FROM transactions ORDER BY created_at DESC LIMIT 2000'
      );
      return r.rows.map(rowToTx);
    },
    async addTransaction(t) {
      const id = crypto.randomUUID();
      const r = await pool.query(
        `INSERT INTO transactions
          (id, client_id, client_name, date, tipo, usd, taxa, brl, obs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, t.clientId, t.clientName, t.date, t.tipo, t.usd, t.taxa, t.brl, t.obs || '']
      );
      return rowToTx(r.rows[0]);
    },
    async deleteTransaction(id) {
      await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
    },
  };
} else {
  // Local development fallback only: a JSON file next to this script.
  // Production always runs with DATABASE_URL set (PostgreSQL) so real
  // client/money data is never stored this way.
  const FILE = path.join(__dirname, '.local-data.json');

  function load() {
    try {
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      return { clients: [], transactions: [] };
    }
  }
  function save(data) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  }

  impl = {
    ready: Promise.resolve(),
    async listClients() {
      return load().clients.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    },
    async addClient(name) {
      const data = load();
      const c = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
      data.clients.push(c);
      save(data);
      return c;
    },
    async deleteClient(id) {
      const data = load();
      data.clients = data.clients.filter((c) => c.id !== id);
      save(data);
    },
    async listTransactions() {
      return load()
        .transactions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 2000);
    },
    async addTransaction(t) {
      const data = load();
      const tx = { ...t, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      data.transactions.push(tx);
      save(data);
      return tx;
    },
    async deleteTransaction(id) {
      const data = load();
      data.transactions = data.transactions.filter((t) => t.id !== id);
      save(data);
    },
  };
}

module.exports = impl;
