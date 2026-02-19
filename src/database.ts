import Database from 'better-sqlite3';
import path from 'path';
import { config } from './config';
import { logger } from './logger';
import type { Server, User, Subscription, Payment, SubscriptionWithServer } from './types';

const DB_PATH = path.join(__dirname, '..', 'data', 'vpn.db');

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    emoji           TEXT NOT NULL,
    inbound_id      INTEGER NOT NULL,
    server_ip       TEXT NOT NULL,
    server_port     INTEGER NOT NULL DEFAULT 443,
    public_key      TEXT NOT NULL,
    short_id        TEXT NOT NULL,
    sni             TEXT NOT NULL,
    is_active       INTEGER DEFAULT 1,
    max_users       INTEGER DEFAULT 100,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     INTEGER UNIQUE NOT NULL,
    username        TEXT DEFAULT '',
    first_name      TEXT DEFAULT '',
    is_blocked      INTEGER DEFAULT 0,
    trial_used      INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     INTEGER NOT NULL,
    server_id       INTEGER NOT NULL,
    client_uuid     TEXT NOT NULL,
    client_email    TEXT NOT NULL,
    tariff_id       TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    max_devices     INTEGER DEFAULT 2,
    traffic_limit   INTEGER DEFAULT 0,
    traffic_used    INTEGER DEFAULT 0,
    is_active       INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
    FOREIGN KEY (server_id) REFERENCES servers(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     INTEGER NOT NULL,
    tariff_id       TEXT NOT NULL,
    server_id       INTEGER NOT NULL,
    amount          INTEGER NOT NULL,
    currency        TEXT DEFAULT 'RUB',
    status          TEXT DEFAULT 'pending',
    invoice_id      TEXT,
    payload         TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    completed_at    TEXT,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
    FOREIGN KEY (server_id) REFERENCES servers(id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,
    message         TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_telegram ON subscriptions(telegram_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(is_active);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
`);

// --- Seed servers from .env (upsert) ---

const upsertServer = db.prepare(`
  INSERT INTO servers (code, name, emoji, inbound_id, server_ip, server_port, public_key, short_id, sni, max_users)
  VALUES (@code, @name, @emoji, @inboundId, @serverIp, @serverPort, @publicKey, @shortId, @sni, @maxUsers)
  ON CONFLICT(code) DO UPDATE SET
    name = @name,
    emoji = @emoji,
    inbound_id = @inboundId,
    server_ip = @serverIp,
    server_port = @serverPort,
    public_key = @publicKey,
    short_id = @shortId,
    sni = @sni,
    max_users = @maxUsers
`);

const seedServers = db.transaction(() => {
  for (const s of config.servers) {
    upsertServer.run({
      code: s.code,
      name: s.name,
      emoji: s.emoji,
      inboundId: s.inboundId,
      serverIp: s.serverIp,
      serverPort: s.serverPort,
      publicKey: s.publicKey,
      shortId: s.shortId,
      sni: s.sni,
      maxUsers: s.maxUsers,
    });
  }
});

seedServers();
logger.info({ serverCount: config.servers.length }, 'Servers seeded from .env');

// --- Prepared queries: Servers ---

export const getServers = (): Server[] =>
  db.prepare('SELECT * FROM servers WHERE is_active = 1').all() as Server[];

export const getServerByCode = (code: string): Server | undefined =>
  db.prepare('SELECT * FROM servers WHERE code = ?').get(code) as Server | undefined;

export const getServerById = (id: number): Server | undefined =>
  db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as Server | undefined;

// --- Prepared queries: Users ---

export const getUser = (telegramId: number): User | undefined =>
  db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as User | undefined;

export const upsertUser = (telegramId: number, username: string, firstName: string): User => {
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      updated_at = datetime('now')
  `).run(telegramId, username, firstName);
  return getUser(telegramId)!;
};

export const markTrialUsed = (telegramId: number): void => {
  db.prepare('UPDATE users SET trial_used = 1, updated_at = datetime(\'now\') WHERE telegram_id = ?').run(telegramId);
};

export const blockUser = (telegramId: number): void => {
  db.prepare('UPDATE users SET is_blocked = 1, updated_at = datetime(\'now\') WHERE telegram_id = ?').run(telegramId);
};

export const getAllUsers = (): User[] =>
  db.prepare('SELECT * FROM users').all() as User[];

export const getActiveUserIds = (): number[] =>
  (db.prepare(`
    SELECT DISTINCT u.telegram_id FROM users u
    JOIN subscriptions s ON s.telegram_id = u.telegram_id
    WHERE s.is_active = 1 AND u.is_blocked = 0
  `).all() as { telegram_id: number }[]).map(r => r.telegram_id);

// --- Prepared queries: Subscriptions ---

export const createSubscription = (
  telegramId: number,
  serverId: number,
  clientUuid: string,
  clientEmail: string,
  tariffId: string,
  expiresAt: string,
  maxDevices: number,
  trafficLimit: number,
): Subscription => {
  const info = db.prepare(`
    INSERT INTO subscriptions (telegram_id, server_id, client_uuid, client_email, tariff_id, expires_at, max_devices, traffic_limit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(telegramId, serverId, clientUuid, clientEmail, tariffId, expiresAt, maxDevices, trafficLimit);
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(info.lastInsertRowid) as Subscription;
};

export const getActiveSubscriptions = (telegramId: number): SubscriptionWithServer[] =>
  db.prepare(`
    SELECT s.*, srv.code as server_code, srv.name as server_name, srv.emoji as server_emoji,
           srv.server_ip, srv.server_port, srv.public_key, srv.short_id, srv.sni
    FROM subscriptions s
    JOIN servers srv ON srv.id = s.server_id
    WHERE s.telegram_id = ? AND s.is_active = 1
    ORDER BY s.created_at DESC
  `).all(telegramId) as SubscriptionWithServer[];

export const getActiveSubscriptionsByServer = (telegramId: number, serverId: number): Subscription[] =>
  db.prepare(`
    SELECT * FROM subscriptions
    WHERE telegram_id = ? AND server_id = ? AND is_active = 1
  `).all(telegramId, serverId) as Subscription[];

export const getAllActiveSubscriptions = (): SubscriptionWithServer[] =>
  db.prepare(`
    SELECT s.*, srv.code as server_code, srv.name as server_name, srv.emoji as server_emoji,
           srv.server_ip, srv.server_port, srv.public_key, srv.short_id, srv.sni
    FROM subscriptions s
    JOIN servers srv ON srv.id = s.server_id
    WHERE s.is_active = 1
  `).all() as SubscriptionWithServer[];

export const getExpiredSubscriptions = (): SubscriptionWithServer[] =>
  db.prepare(`
    SELECT s.*, srv.code as server_code, srv.name as server_name, srv.emoji as server_emoji,
           srv.server_ip, srv.server_port, srv.public_key, srv.short_id, srv.sni
    FROM subscriptions s
    JOIN servers srv ON srv.id = s.server_id
    WHERE s.is_active = 1 AND s.expires_at <= datetime('now')
  `).all() as SubscriptionWithServer[];

export const getOverTrafficSubscriptions = (): SubscriptionWithServer[] =>
  db.prepare(`
    SELECT s.*, srv.code as server_code, srv.name as server_name, srv.emoji as server_emoji,
           srv.server_ip, srv.server_port, srv.public_key, srv.short_id, srv.sni
    FROM subscriptions s
    JOIN servers srv ON srv.id = s.server_id
    WHERE s.is_active = 1 AND s.traffic_limit > 0 AND s.traffic_used >= s.traffic_limit
  `).all() as SubscriptionWithServer[];

export const deactivateSubscription = (id: number): void => {
  db.prepare('UPDATE subscriptions SET is_active = 0 WHERE id = ?').run(id);
};

export const updateSubscriptionTraffic = (id: number, trafficUsed: number): void => {
  db.prepare('UPDATE subscriptions SET traffic_used = ? WHERE id = ?').run(trafficUsed, id);
};

export const deactivateAllUserSubscriptions = (telegramId: number): Subscription[] => {
  const subs = db.prepare('SELECT * FROM subscriptions WHERE telegram_id = ? AND is_active = 1').all(telegramId) as Subscription[];
  db.prepare('UPDATE subscriptions SET is_active = 0 WHERE telegram_id = ? AND is_active = 1').run(telegramId);
  return subs;
};

export const getSubscriptionById = (id: number): Subscription | undefined =>
  db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Subscription | undefined;

export const countActiveSubscriptionsByServer = (serverId: number): number =>
  (db.prepare('SELECT COUNT(*) as cnt FROM subscriptions WHERE server_id = ? AND is_active = 1').get(serverId) as { cnt: number }).cnt;

// --- Prepared queries: Payments ---

export const createPayment = (
  telegramId: number,
  tariffId: string,
  serverId: number,
  amount: number,
  invoiceId: string,
  payload: string,
): Payment => {
  const info = db.prepare(`
    INSERT INTO payments (telegram_id, tariff_id, server_id, amount, invoice_id, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(telegramId, tariffId, serverId, amount, invoiceId, payload);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid) as Payment;
};

export const getPendingPayments = (): Payment[] =>
  db.prepare("SELECT * FROM payments WHERE status = 'pending'").all() as Payment[];

export const getPaymentByInvoiceId = (invoiceId: string): Payment | undefined =>
  db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(invoiceId) as Payment | undefined;

export const completePayment = (id: number): void => {
  db.prepare("UPDATE payments SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(id);
};

export const expirePayment = (id: number): void => {
  db.prepare("UPDATE payments SET status = 'expired' WHERE id = ?").run(id);
};

export const expireOldPayments = (): number => {
  const result = db.prepare(`
    UPDATE payments SET status = 'expired'
    WHERE status = 'pending' AND created_at <= datetime('now', '-24 hours')
  `).run();
  return result.changes;
};

export const getPaymentStats = (): { total_revenue: number; total_payments: number } =>
  db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total_revenue, COUNT(*) as total_payments
    FROM payments WHERE status = 'completed'
  `).get() as { total_revenue: number; total_payments: number };

// --- Prepared queries: Alerts ---

export const createAlert = (type: string, message: string): void => {
  db.prepare('INSERT INTO alerts (type, message) VALUES (?, ?)').run(type, message);
};

// --- DB management ---

export const closeDb = (): void => {
  db.close();
  logger.info('Database closed');
};

export default db;
