const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();

const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin123';

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user && pass && safeEqual(user, APP_USER) && safeEqual(pass, APP_PASSWORD)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Mesa de Câmbio"');
  res.status(401).send('Autenticação necessária.');
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/clients', async (req, res) => {
  await db.ready;
  res.json(await db.listClients());
});

app.post('/api/clients', async (req, res) => {
  await db.ready;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await db.addClient(name));
});

app.put('/api/clients/:id', async (req, res) => {
  await db.ready;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const updated = await db.renameClient(req.params.id, name);
  if (!updated) return res.status(404).json({ error: 'client not found' });
  res.json(updated);
});

app.delete('/api/clients/:id', async (req, res) => {
  await db.ready;
  const id = req.params.id;
  const [txs, pend] = await Promise.all([db.listTransactions(), db.listPending()]);
  const hasHistory = txs.some((t) => t.clientId === id) || pend.some((p) => p.clientId === id);
  if (hasHistory) {
    return res.status(400).json({ error: 'client has transactions or pending amounts' });
  }
  await db.deleteClient(id);
  res.json({ ok: true });
});

app.get('/api/transactions', async (req, res) => {
  await db.ready;
  res.json(await db.listTransactions());
});

app.post('/api/transactions', async (req, res) => {
  await db.ready;
  const { clientId, clientName, date, tipo, usd, taxa, obs } = req.body;
  const usdNum = Number(usd);
  const taxaNum = Number(taxa);
  if (
    !clientId ||
    !clientName ||
    !date ||
    (tipo !== 'Compra' && tipo !== 'Venda') ||
    !(usdNum > 0) ||
    !(taxaNum > 0)
  ) {
    return res.status(400).json({ error: 'invalid transaction' });
  }
  const brl = Math.round(usdNum * taxaNum * 100) / 100;
  const tx = await db.addTransaction({
    clientId,
    clientName,
    date,
    tipo,
    usd: usdNum,
    taxa: taxaNum,
    brl,
    obs: (obs || '').slice(0, 500),
  });
  res.json(tx);
});

app.delete('/api/transactions/:id', async (req, res) => {
  await db.ready;
  await db.deleteTransaction(req.params.id);
  res.json({ ok: true });
});

app.get('/api/transactions/trash', async (req, res) => {
  await db.ready;
  res.json(await db.listTrashedTransactions());
});

app.post('/api/transactions/restore-all', async (req, res) => {
  await db.ready;
  res.json({ restored: await db.restoreAllTransactions() });
});

app.post('/api/transactions/:id/restore', async (req, res) => {
  await db.ready;
  const tx = await db.restoreTransaction(req.params.id);
  if (!tx) return res.status(404).json({ error: 'not found in trash' });
  res.json(tx);
});

app.delete('/api/transactions/:id/purge', async (req, res) => {
  await db.ready;
  await db.purgeTransaction(req.params.id);
  res.json({ ok: true });
});

app.get('/api/pending', async (req, res) => {
  await db.ready;
  res.json(await db.listPending());
});

app.post('/api/pending', async (req, res) => {
  await db.ready;
  const { clientId, clientName, tipo, brl, obs } = req.body;
  const brlNum = Number(brl);
  // tipo is optional: omitted (or null) means "not classified yet" —
  // used by the WhatsApp bot, which only confirms an amount and leaves
  // Compra/Venda for a human to decide when closing.
  if (
    !clientId ||
    !clientName ||
    (tipo != null && tipo !== 'Compra' && tipo !== 'Venda') ||
    !(brlNum > 0)
  ) {
    return res.status(400).json({ error: 'invalid pending entry' });
  }
  const entry = await db.addPending({
    clientId,
    clientName,
    tipo: tipo || null,
    brl: brlNum,
    obs: (obs || '').slice(0, 500),
  });
  res.json(entry);
});

app.delete('/api/pending/:id', async (req, res) => {
  await db.ready;
  await db.deletePending(req.params.id);
  res.json({ ok: true });
});

app.post('/api/pending/close', async (req, res) => {
  await db.ready;
  const { clientId, clientName, sourceTipo, targetTipo, taxa, date, obs } = req.body;
  const taxaNum = Number(taxa);
  if (
    !clientId ||
    !clientName ||
    (sourceTipo != null && sourceTipo !== 'Compra' && sourceTipo !== 'Venda') ||
    (targetTipo !== 'Compra' && targetTipo !== 'Venda') ||
    !(taxaNum > 0) ||
    !date
  ) {
    return res.status(400).json({ error: 'invalid close request' });
  }
  const tx = await db.closePending({
    clientId,
    clientName,
    sourceTipo: sourceTipo || null,
    targetTipo,
    taxa: taxaNum,
    date,
    obs: (obs || '').slice(0, 500),
  });
  if (!tx) return res.status(400).json({ error: 'no pending amount for this client/tipo' });
  res.json(tx);
});

app.get('/api/daily-cost', async (req, res) => {
  await db.ready;
  res.json(await db.listDailyCosts());
});

app.put('/api/daily-cost/:date', async (req, res) => {
  await db.ready;
  const date = req.params.date;
  const custo = Number(req.body.custo);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(custo > 0)) {
    return res.status(400).json({ error: 'invalid daily cost' });
  }
  res.json(await db.setDailyCost(date, custo));
});

app.get('/api/contracts', async (req, res) => {
  await db.ready;
  res.json(await db.listContracts());
});

app.post('/api/contracts', async (req, res) => {
  await db.ready;
  const { clientId, clientName, tipo, totalUsd, taxa, date, obs } = req.body;
  const totalUsdNum = Number(totalUsd);
  const taxaNum = Number(taxa);
  if (
    !clientId ||
    !clientName ||
    (tipo !== 'Compra' && tipo !== 'Venda') ||
    !(totalUsdNum > 0) ||
    !(taxaNum > 0) ||
    !date
  ) {
    return res.status(400).json({ error: 'invalid contract' });
  }
  const contract = await db.addContract({
    clientId,
    clientName,
    tipo,
    totalUsd: totalUsdNum,
    taxa: taxaNum,
    date,
    obs: (obs || '').slice(0, 500),
  });
  res.json(contract);
});

app.delete('/api/contracts/:id', async (req, res) => {
  await db.ready;
  const ok = await db.deleteContract(req.params.id);
  if (!ok) return res.status(400).json({ error: 'contract has movements' });
  res.json({ ok: true });
});

app.post('/api/contracts/:id/movements', async (req, res) => {
  await db.ready;
  const { kind, valor, obs } = req.body;
  const valorNum = Number(valor);
  if ((kind !== 'usd' && kind !== 'brl') || !(valorNum > 0)) {
    return res.status(400).json({ error: 'invalid movement' });
  }
  const movement = await db.addContractMovement(req.params.id, {
    kind,
    valor: valorNum,
    obs: (obs || '').slice(0, 500),
  });
  res.json(movement);
});

app.delete('/api/contract-movements/:id', async (req, res) => {
  await db.ready;
  await db.deleteContractMovement(req.params.id);
  res.json({ ok: true });
});

app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Mesa de Câmbio rodando na porta ' + PORT);
});
