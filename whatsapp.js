const db = require('./db');

const PORT = process.env.PORT || 3000;
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin123';
const AUTH_HEADER = 'Basic ' + Buffer.from(APP_USER + ':' + APP_PASSWORD).toString('base64');

// Aceita: "ok 1000", "ok1000", "ok: 1.000", "ok R$ 1000,50" (case-insensitive)
const CONFIRM_RE = /^\s*ok\s*[:\-]?\s*(?:r\$\s*)?([\d.,]+)/i;

let baileys = null;
let sock = null;
let generation = 0;
const state = { status: 'desativado', detail: '' };

function log(...args) {
  console.log('[whatsapp]', ...args);
}

function parseValorBR(raw) {
  let s = raw.trim();
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeJid(jid) {
  if (!jid) return '';
  const [userPart, domain] = jid.split('@');
  const user = (userPart || '').split(':')[0];
  return user + '@' + (domain || '');
}

function unwrapMessage(message) {
  if (!message) return message;
  if (message.ephemeralMessage) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return unwrapMessage(message.viewOnceMessageV2.message);
  return message;
}

function extractText(message) {
  const m = unwrapMessage(message);
  if (!m) return '';
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    ''
  );
}

// Sessao do WhatsApp guardada no banco (o disco do Render some a cada deploy).
// Mesmos nomes de arquivo que o useMultiFileAuthState usa, entao a pasta
// auth_info existente pode ser importada como esta.
async function useDbAuthState() {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  const fixName = (f) => f.replace(/\//g, '__').replace(/:/g, '-');
  let writeChain = Promise.resolve();
  const enqueue = (fn) => {
    writeChain = writeChain.then(fn, fn);
    return writeChain;
  };
  const readData = async (name) => {
    const raw = await db.kvGet(fixName(name));
    return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
  };
  const writeData = (value, name) =>
    enqueue(() => db.kvSet(fixName(name), JSON.stringify(value, BufferJSON.replacer)));
  const removeData = (name) => enqueue(() => db.kvDel(fixName(name)));

  const creds = (await readData('creds.json')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}

let configCache = null;
let configCacheAt = 0;
async function getConfig() {
  const now = Date.now();
  if (!configCache || now - configCacheAt > 15000) {
    const raw = await db.kvGet('config.json');
    configCache = raw ? JSON.parse(raw) : {};
    configCacheAt = now;
  }
  return configCache;
}
function invalidateConfig() {
  configCache = null;
}

async function setConfig(patch) {
  const raw = await db.kvGet('config.json');
  const current = raw ? JSON.parse(raw) : {};
  const next = { ...current, ...patch };
  await db.kvSet('config.json', JSON.stringify(next));
  invalidateConfig();
  return next;
}

const groupSubjectCache = new Map();
async function getGroupSubject(s, jid) {
  if (groupSubjectCache.has(jid)) return groupSubjectCache.get(jid);
  const meta = await s.groupMetadata(jid);
  groupSubjectCache.set(jid, meta.subject);
  return meta.subject;
}

async function postPending(body) {
  const r = await fetch('http://127.0.0.1:' + PORT + '/api/pending', {
    method: 'POST',
    headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('POST /api/pending -> HTTP ' + r.status);
  return r.json();
}

async function handleMessage(s, msg) {
  try {
    if (!msg.message || msg.key.fromMe) return;
    const remoteJid = msg.key.remoteJid || '';
    if (!remoteJid.endsWith('@g.us')) return;

    const text = extractText(msg.message).trim();
    const match = text.match(CONFIRM_RE);
    if (!match) return;

    const config = await getConfig();
    const authorized = new Set(
      [
        config.employeeNumber ? String(config.employeeNumber).replace(/\D/g, '') + '@s.whatsapp.net' : null,
        config.employeeLid ? String(config.employeeLid).replace(/\D/g, '') + '@lid' : null,
      ].filter(Boolean)
    );
    const senderJid = normalizeJid(msg.key.participant || '');
    if (!authorized.has(senderJid)) return;

    const valor = parseValorBR(match[1]);
    if (!(valor > 0)) {
      log('valor invalido na mensagem de confirmacao: "' + text + '"');
      return;
    }

    const groupSubject = await getGroupSubject(s, remoteJid);
    const clientName = (config.groups || {})[groupSubject];
    if (!clientName) {
      log('grupo "' + groupSubject + '" nao esta mapeado — ignorando.');
      return;
    }

    const clients = await db.listClients();
    const client = clients.find((c) => c.name === clientName);
    if (!client) {
      log('cliente "' + clientName + '" nao encontrado no Mesa de Cambio — cadastre antes.');
      return;
    }

    await postPending({ clientId: client.id, clientName: client.name, brl: valor });
    log('confirmado R$ ' + valor.toFixed(2) + ' para "' + client.name + '" (grupo "' + groupSubject + '")');

    try {
      await s.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
    } catch (e) {
      // reagir e so feedback visual
    }
  } catch (err) {
    console.error('[whatsapp] erro processando mensagem:', err.message);
  }
}

async function connect() {
  const myGen = ++generation;
  if (!baileys) baileys = await import('@whiskeysockets/baileys');
  const pino = require('pino');
  const { state: authState, saveCreds } = await useDbAuthState();
  const { version } = await baileys.fetchLatestBaileysVersion();

  const s = baileys.default({
    version,
    auth: authState,
    logger: pino({ level: 'silent' }),
  });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', (update) => {
    if (myGen !== generation) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // sessao invalida: na nuvem nao da pra ler QR, precisa reimportar
      state.status = 'precisa-novo-login';
      state.detail = 'Sessao do WhatsApp invalida. Precisa importar uma sessao nova.';
      log(state.detail);
      s.end(undefined);
      return;
    }
    if (connection === 'open') {
      state.status = 'conectado';
      state.detail = '';
      log('conectado ao WhatsApp');
    } else if (connection === 'close') {
      const code =
        lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode
          : null;
      if (state.status === 'precisa-novo-login') return;
      if (code === baileys.DisconnectReason.loggedOut) {
        state.status = 'deslogado';
        state.detail = 'WhatsApp desconectou este aparelho (logout).';
        log(state.detail);
        return;
      }
      if (code === baileys.DisconnectReason.connectionReplaced) {
        state.status = 'substituido';
        state.detail = 'Outra instancia do bot assumiu a sessao.';
        log(state.detail);
        return;
      }
      state.status = 'reconectando';
      state.detail = 'codigo ' + code;
      log('conexao fechada (codigo ' + code + '), reconectando em 3s');
      setTimeout(() => {
        if (myGen !== generation) return;
        connect().catch((err) => {
          state.status = 'erro';
          state.detail = err.message;
          console.error('[whatsapp] falha ao reconectar:', err.message);
        });
      }, 3000);
    }
  });

  s.ev.on('messages.upsert', async ({ messages, type }) => {
    if (myGen !== generation || type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(s, msg);
    }
  });
}

let keepAliveTimer = null;
function startKeepAlive() {
  // O plano gratis do Render dorme sem requisicoes de fora; bater na propria
  // URL publica conta como requisicao e mantem o bot acordado.
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url || keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    fetch(url + '/api/health').catch(() => {});
  }, 10 * 60 * 1000);
}

async function start() {
  if (!process.env.DATABASE_URL) return;
  const creds = await db.kvGet('creds.json');
  if (!creds) {
    state.status = 'sem-sessao';
    state.detail = 'Nenhuma sessao do WhatsApp importada ainda.';
    return;
  }
  state.status = 'conectando';
  state.detail = '';
  startKeepAlive();
  await connect();
}

async function restart() {
  generation++;
  if (sock) {
    try {
      sock.end(undefined);
    } catch (e) {
      // ja fechado
    }
    sock = null;
  }
  await start();
}

module.exports = { start, restart, setConfig, status: () => ({ ...state }) };
