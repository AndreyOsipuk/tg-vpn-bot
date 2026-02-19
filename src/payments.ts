import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Telegraf } from 'telegraf';
import { config } from './config';
import { logger } from './logger';
import {
  getPendingPayments, getPaymentByInvoiceId, completePayment,
  createSubscription, getServerById,
  markTrialUsed, expireOldPayments,
} from './database';
import { getTariff } from './tariffs';
import { addClient, buildVlessLink } from './vpn-manager';
import { formatDate } from './helpers';
import type { Payment, TariffId } from './types';

let bot: Telegraf | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;

export let salesBlocked = false;

export function toggleSales(): boolean {
  salesBlocked = !salesBlocked;
  return salesBlocked;
}

export function setBotInstance(b: Telegraf): void {
  bot = b;
}

// --- YooMoney QuickPay URL ---

export function buildPayUrl(amount: number, label: string): string {
  const params = new URLSearchParams({
    receiver: config.yoomoneyWallet,
    'quickpay-form': 'button',
    paymentType: 'AC',
    sum: String(amount),
    label,
    successURL: 'https://t.me',
  });
  return `https://yoomoney.ru/quickpay/confirm?${params.toString()}`;
}

// --- YooMoney API: check payment by label ---

export async function checkYooMoneyPayment(label: string): Promise<boolean> {
  if (!config.yoomoneyToken) return false;

  try {
    const res = await fetch('https://yoomoney.ru/api/operation-history', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.yoomoneyToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `type=deposition&label=${encodeURIComponent(label)}&records=1`,
    });

    const data = (await res.json()) as {
      operations?: { status: string }[];
    };

    if (data.operations && data.operations.length > 0) {
      return data.operations[0].status === 'success';
    }
  } catch (err) {
    logger.error({ error: (err as Error).message, label }, 'YooMoney API error');
  }
  return false;
}

// --- Generate unique payment label ---

export function generatePaymentLabel(userId: number, serverCode: string, tariffId: string): string {
  const rand = crypto.randomBytes(4).toString('hex');
  return `pay_${userId}_${serverCode}_${tariffId}_${rand}`;
}

// --- Activation ---

export async function activateSubscription(payment: Payment): Promise<void> {
  if (!bot) return;

  const server = getServerById(payment.server_id);
  if (!server) {
    logger.error({ paymentId: payment.id }, 'Server not found for payment');
    return;
  }

  const tariff = getTariff(server.code, payment.tariff_id as TariffId);
  if (!tariff) {
    logger.error({ paymentId: payment.id, tariffId: payment.tariff_id }, 'Tariff not found');
    return;
  }

  // Generate UUID and email
  const clientUuid = uuidv4();
  const clientEmail = `tg_${payment.telegram_id}_${server.code}_${clientUuid.slice(0, 8)}`;

  // Calculate expiry
  let expiresAt: Date;
  if (tariff.minutes) {
    expiresAt = new Date(Date.now() + tariff.minutes * 60_000);
  } else {
    expiresAt = new Date(Date.now() + tariff.days * 24 * 60 * 60_000);
  }
  const expiryMs = expiresAt.getTime();

  // Add client to 3X-UI (trafficBytes=0 = unlimited)
  await addClient(
    server.code,
    clientUuid,
    clientEmail,
    tariff.maxDevices,
    0,
    expiryMs,
  );

  // Save subscription in DB (traffic_limit=0 = unlimited)
  const sub = createSubscription(
    payment.telegram_id,
    server.id,
    clientUuid,
    clientEmail,
    tariff.id,
    expiresAt.toISOString(),
    tariff.maxDevices,
    0,
  );

  // Mark payment as completed
  completePayment(payment.id);

  // Mark trial used
  if (tariff.id === 'trial') {
    markTrialUsed(payment.telegram_id);
  }

  // Build vless link
  const label = `VPN-${server.code.toUpperCase()}-${sub.id}`;
  const vlessLink = buildVlessLink(server.code, clientUuid, label);

  // Notify user
  const msg = [
    'Подписка активирована!',
    '',
    `Тариф: ${tariff.label.split('—')[0].trim()}`,
    `Сервер: ${server.emoji} ${server.name}`,
    `До: ${formatDate(expiresAt.toISOString())} (UTC)`,
    `Устройства: до ${tariff.maxDevices}`,
    '',
    'Ссылка для подключения:',
    `<code>${vlessLink}</code>`,
    '',
    '<b>Как подключить:</b>',
    '',
    '<b>Android:</b>',
    '1. Скачай v2rayNG из Google Play или GitHub',
    '2. Скопируй ссылку выше (нажми на неё)',
    '3. Открой v2rayNG → + → Импорт из буфера',
    '4. Нажми кнопку подключения (▶)',
    '',
    '<b>iOS:</b>',
    '1. Скачай Hiddify из App Store (или Streisand)',
    '2. Скопируй ссылку выше (нажми на неё)',
    '3. Открой Hiddify → + → Добавить из буфера',
    '4. Нажми кнопку подключения',
    '',
    'Проблемы? Напиши /support',
  ].join('\n');

  await bot.telegram.sendMessage(payment.telegram_id, msg, { parse_mode: 'HTML' });
  logger.info({ telegramId: payment.telegram_id, subId: sub.id, serverCode: server.code }, 'Subscription activated');
}

// --- Polling: check all pending payments via YooMoney API ---

async function pollPendingPayments(): Promise<void> {
  const pending = getPendingPayments();
  if (pending.length === 0) return;

  for (const payment of pending) {
    if (!payment.invoice_id) continue;

    try {
      const paid = await checkYooMoneyPayment(payment.invoice_id);
      if (paid) {
        logger.info({ label: payment.invoice_id }, 'Polling: payment confirmed');
        await activateSubscription(payment);
      }
    } catch (err) {
      logger.error({ label: payment.invoice_id, error: (err as Error).message }, 'Polling check failed');
    }
  }
}

export function startPolling(): void {
  pollingInterval = setInterval(() => {
    pollPendingPayments().catch(err => {
      logger.error({ error: (err as Error).message }, 'Payment polling error');
    });
  }, 15_000);
  logger.info('Payment polling started (15s interval)');
}

// --- Shutdown ---

export function stopPayments(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
