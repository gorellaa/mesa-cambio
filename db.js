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
    breakdown: r.breakdown ? JSON.parse(r.breakdown) : null,
    createdAt: r.created_at,
    deletedAt: r.deleted_at || null,
  };
}
function rowToPending(r) {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    tipo: r.tipo,
    // the underlying column is still named "usd" for historical reasons,
    // but pending entries hold a BRL amount (converted at close time)
    brl: Number(r.usd),
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
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS breakdown TEXT`);
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pending (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      tipo TEXT,
      usd DOUBLE PRECISION NOT NULL,
      obs TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // tipo used to be required; entries confirmed by the WhatsApp bot arrive
    // with no tipo yet (classified as Compra/Venda only when closed)
    await pool.query(`ALTER TABLE pending ALTER COLUMN tipo DROP NOT NULL`);
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_cost (
      date TEXT PRIMARY KEY,
      custo DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    async renameClient(id, name) {
      const r = await pool.query(
        'UPDATE clients SET name = $1 WHERE id = $2 RETURNING *',
        [name, id]
      );
      return r.rows[0] ? rowToClient(r.rows[0]) : null;
    },
    async listTransactions() {
      const r = await pool.query(
        'SELECT * FROM transactions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 2000'
      );
      return r.rows.map(rowToTx);
    },
    async listTrashedTransactions() {
      const r = await pool.query(
        'SELECT * FROM transactions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500'
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
      // soft delete: keeps the row (recoverable from the Lixeira) instead of
      // losing the whole day's breakdown to one accidental click
      await pool.query('UPDATE transactions SET deleted_at = now() WHERE id = $1', [id]);
    },
    async restoreTransaction(id) {
      const r = await pool.query(
        'UPDATE transactions SET deleted_at = NULL WHERE id = $1 RETURNING *',
        [id]
      );
      return r.rows[0] ? rowToTx(r.rows[0]) : null;
    },
    async purgeTransaction(id) {
      await pool.query('DELETE FROM transactions WHERE id = $1 AND deleted_at IS NOT NULL', [id]);
    },
    async listPending() {
      const r = await pool.query(
        'SELECT * FROM pending ORDER BY created_at ASC LIMIT 2000'
      );
      return r.rows.map(rowToPending);
    },
    async addPending(p) {
      const id = crypto.randomUUID();
      const r = await pool.query(
        `INSERT INTO pending (id, client_id, client_name, tipo, usd, obs)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, p.clientId, p.clientName, p.tipo || null, p.brl, p.obs || '']
      );
      return rowToPending(r.rows[0]);
    },
    async deletePending(id) {
      await pool.query('DELETE FROM pending WHERE id = $1', [id]);
    },
    async closePending({ clientId, clientName, sourceTipo, targetTipo, taxa, date, obs }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const rowsR = await client.query(
          'SELECT usd FROM pending WHERE client_id = $1 AND tipo IS NOT DISTINCT FROM $2 ORDER BY created_at ASC',
          [clientId, sourceTipo || null]
        );
        const amounts = rowsR.rows.map((r) => Number(r.usd));
        const brl = Math.round(amounts.reduce((s, v) => s + v, 0) * 100) / 100;
        if (!(brl > 0)) {
          await client.query('ROLLBACK');
          return null;
        }
        const usd = Math.round((brl / taxa) * 100) / 100;
        const id = crypto.randomUUID();
        const txR = await client.query(
          `INSERT INTO transactions
            (id, client_id, client_name, date, tipo, usd, taxa, brl, obs, breakdown)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [id, clientId, clientName, date, targetTipo, usd, taxa, brl, obs || '', JSON.stringify(amounts)]
        );
        await client.query('DELETE FROM pending WHERE client_id = $1 AND tipo IS NOT DISTINCT FROM $2', [
          clientId,
          sourceTipo || null,
        ]);
        await client.query('COMMIT');
        return rowToTx(txR.rows[0]);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async listDailyCosts() {
      const r = await pool.query('SELECT * FROM daily_cost');
      return r.rows.map((row) => ({ date: row.date, custo: Number(row.custo) }));
    },
    async setDailyCost(date, custo) {
      const r = await pool.query(
        `INSERT INTO daily_cost (date, custo) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET custo = $2, updated_at = now()
         RETURNING *`,
        [date, custo]
      );
      return { date: r.rows[0].date, custo: Number(r.rows[0].custo) };
    },
  };
} else {
  // Local development fallback only: a JSON file next to this script.
  // Production always runs with DATABASE_URL set (PostgreSQL) so real
  // client/money data is never stored this way.
  const FILE = path.join(__dirname, '.local-data.json');

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!data.pending) data.pending = [];
      if (!data.dailyCosts) data.dailyCosts = [];
      return data;
    } catch (e) {
      return { clients: [], transactions: [], pending: [], dailyCosts: [] };
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
    async renameClient(id, name) {
      const data = load();
      const c = data.clients.find((c) => c.id === id);
      if (!c) return null;
      c.name = name;
      save(data);
      return c;
    },
    async listTransactions() {
      return load()
        .transactions.filter((t) => !t.deletedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 2000);
    },
    async listTrashedTransactions() {
      return load()
        .transactions.filter((t) => t.deletedAt)
        .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
        .slice(0, 500);
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
      const tx = data.transactions.find((t) => t.id === id);
      if (tx) tx.deletedAt = new Date().toISOString();
      save(data);
    },
    async restoreTransaction(id) {
      const data = load();
      const tx = data.transactions.find((t) => t.id === id);
      if (!tx) return null;
      delete tx.deletedAt;
      save(data);
      return tx;
    },
    async purgeTransaction(id) {
      const data = load();
      data.transactions = data.transactions.filter((t) => !(t.id === id && t.deletedAt));
      save(data);
    },
    async listPending() {
      return load().pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async addPending(p) {
      const data = load();
      const entry = {
        ...p,
        tipo: p.tipo || null,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      data.pending.push(entry);
      save(data);
      return entry;
    },
    async deletePending(id) {
      const data = load();
      data.pending = data.pending.filter((p) => p.id !== id);
      save(data);
    },
    async closePending({ clientId, clientName, sourceTipo, targetTipo, taxa, date, obs }) {
      const data = load();
      const src = sourceTipo || null;
      const matching = data.pending
        .filter((p) => p.clientId === clientId && (p.tipo || null) === src)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const amounts = matching.map((p) => p.brl);
      const brl = Math.round(amounts.reduce((s, v) => s + v, 0) * 100) / 100;
      if (!(brl > 0)) return null;
      const usd = Math.round((brl / taxa) * 100) / 100;
      const tx = {
        id: crypto.randomUUID(),
        clientId,
        clientName,
        date,
        tipo: targetTipo,
        usd,
        taxa,
        brl,
        obs: obs || '',
        breakdown: amounts,
        createdAt: new Date().toISOString(),
      };
      data.transactions.push(tx);
      data.pending = data.pending.filter((p) => !(p.clientId === clientId && (p.tipo || null) === src));
      save(data);
      return tx;
    },
    async listDailyCosts() {
      return load().dailyCosts;
    },
    async setDailyCost(date, custo) {
      const data = load();
      const existing = data.dailyCosts.find((d) => d.date === date);
      if (existing) existing.custo = custo;
      else data.dailyCosts.push({ date, custo });
      save(data);
      return { date, custo };
    },
  };
}

module.exports = impl;
