import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { config } from './config';
import { logger } from './logger';
import {
  upsertUser, getUser, getServers, getServerByCode,
  getActiveSubscriptions, createPayment,
} from './database';
import { getServerTariffs, getTariff } from './tariffs';
import { buildVlessLink } from './vpn-manager';
import { salesBlocked, buildPayUrl, generatePaymentLabel, checkYooMoneyPayment, activateSubscription } from './payments';
import { formatTimeLeft } from './helpers';
import type { TariffId } from './types';

// --- /start ---

export async function handleStart(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  upsertUser(from.id, from.username || '', from.first_name || '');

  const servers = getServers();

  const buttons = servers.map(srv => {
    return [Markup.button.callback(`${srv.emoji} ${srv.name}`, `server:${srv.code}`)];
  });

  const text = [
    'Привет! Это бот для VPN доступа.',
    '',
    'Быстрый, надёжный VPN на базе VLESS + Reality.',
    '',
    'Перед покупкой скачай приложение:',
    '  Android — v2rayNG',
    '  iOS — Hiddify / Streisand',
    '',
    'Выбери локацию:',
  ].join('\n');

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

// --- Server selection callback → show tariffs ---

export async function handleServerSelect(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const from = ctx.from;
  if (!from) return;

  const serverCode = ctx.callbackQuery.data.replace('server:', '');
  const server = getServerByCode(serverCode);
  if (!server) {
    await ctx.answerCbQuery('Сервер не найден');
    return;
  }

  const tariffs = getServerTariffs(serverCode);
  if (!tariffs) {
    await ctx.answerCbQuery('Тарифы не настроены');
    return;
  }

  const user = getUser(from.id);
  const trialUsed = user?.trial_used === 1;

  const buttons = tariffs
    .filter(t => !(t.id === 'trial' && trialUsed))
    .map(t => [Markup.button.callback(t.label, `buy:${serverCode}:${t.id}`)]);

  buttons.push([Markup.button.callback('← Назад', 'back_to_servers')]);

  const text = `Тарифы (${server.emoji} ${server.name}):`;

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
}

// --- Back to server list ---

export async function handleBackToServers(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const servers = getServers();

  const buttons = servers.map(srv => {
    return [Markup.button.callback(`${srv.emoji} ${srv.name}`, `server:${srv.code}`)];
  });

  const text = 'Выбери локацию:';
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
}

// --- Buy tariff callback ---

export async function handleBuy(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const from = ctx.from;
  if (!from) return;

  const parts = ctx.callbackQuery.data.split(':');
  const serverCode = parts[1];
  const tariffId = parts[2] as TariffId;

  const server = getServerByCode(serverCode);
  if (!server) {
    await ctx.answerCbQuery('Сервер не найден');
    return;
  }

  const tariff = getTariff(serverCode, tariffId);
  if (!tariff) {
    await ctx.answerCbQuery('Тариф не найден');
    return;
  }

  if (salesBlocked && tariff.price > 0) {
    await ctx.answerCbQuery('Продажи временно приостановлены');
    return;
  }

  const user = getUser(from.id);

  // Trial
  if (tariff.id === 'trial') {
    if (user?.trial_used === 1) {
      await ctx.answerCbQuery('Триал уже использован');
      return;
    }

    // For trial, create a fake payment and activate immediately
    const payment = createPayment(from.id, tariff.id, server.id, 0, `trial_${from.id}_${Date.now()}`, '');
    await activateSubscription(payment);
    await ctx.answerCbQuery('Триал активирован!');
    return;
  }

  // Paid tariff — create YooMoney payment link
  await ctx.answerCbQuery();

  const label = generatePaymentLabel(from.id, serverCode, tariffId);
  const payUrl = buildPayUrl(tariff.price, label);

  // Save payment in DB (invoice_id = yoomoney label)
  createPayment(from.id, tariff.id, server.id, tariff.price, label, '');

  await ctx.editMessageText(
    `Оплата: ${tariff.price} руб.\n${server.emoji} ${server.name} — ${tariff.label.split('—')[0].trim()}\n\n`
    + 'Нажми «Оплатить», оплати картой.\nПосле оплаты нажми «Я оплатил» или подожди до 30 сек.',
    Markup.inlineKeyboard([
      [Markup.button.url('Оплатить', payUrl)],
      [Markup.button.callback('Я оплатил', `check:${label}`)],
      [Markup.button.callback('← Назад', `server:${serverCode}`)],
    ]),
  );
}

// --- Check payment callback ---

export async function handleCheckPayment(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const from = ctx.from;
  if (!from) return;

  const label = ctx.callbackQuery.data.replace('check:', '');

  const { getPaymentByInvoiceId } = await import('./database');
  const payment = getPaymentByInvoiceId(label);

  if (!payment || payment.status !== 'pending') {
    await ctx.answerCbQuery('Платёж не найден или уже обработан');
    return;
  }

  await ctx.answerCbQuery('Проверяю...');

  const paid = await checkYooMoneyPayment(label);
  if (paid) {
    await activateSubscription(payment);
  } else {
    await ctx.reply(
      'Оплата пока не поступила.\nПодожди 1-2 минуты или нажми ещё раз.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Я оплатил', `check:${label}`)],
      ]),
    );
  }
}

// --- /status ---

export async function handleStatus(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const subs = getActiveSubscriptions(from.id);

  if (subs.length === 0) {
    await ctx.reply('У тебя нет активных подписок.', Markup.inlineKeyboard([
      [Markup.button.callback('Купить VPN', 'back_to_servers')],
    ]));
    return;
  }

  const lines: string[] = ['Твои подписки:', ''];

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const timeLeft = formatTimeLeft(s.expires_at);
    lines.push(`${i + 1}. ${s.server_emoji} ${s.server_name} — ${timeLeft}`);
    lines.push('');
  }

  await ctx.reply(lines.join('\n'), Markup.inlineKeyboard([
    [Markup.button.callback('Купить ещё', 'back_to_servers')],
    [Markup.button.callback('Все ссылки', 'show_keys')],
  ]));
}

// --- /keys and show_keys callback ---

export async function handleKeys(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const subs = getActiveSubscriptions(from.id);

  if (subs.length === 0) {
    await ctx.reply('У тебя нет активных подписок.');
    return;
  }

  const lines: string[] = ['Твои ссылки для подключения:', ''];

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const label = `VPN-${s.server_code.toUpperCase()}-${i + 1}`;
    const link = buildVlessLink(s.server_code, s.client_uuid, label);
    lines.push(`${i + 1}. ${s.server_emoji} ${s.server_name}:`);
    lines.push(`<code>${link}</code>`);
    lines.push('');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleShowKeys(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery) return;
  await ctx.answerCbQuery();
  await handleKeys(ctx);
}

// --- /support ---

export async function handleSupport(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  await ctx.reply(
    'Опиши проблему в следующем сообщении, и мы поможем.\n'
    + 'Можешь отправить текст, скриншот или видео.',
  );
}

// --- Forward user message to admin ---

export async function handleUserMessage(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  // Don't forward admin's own messages
  if (from.id === config.adminId) return;

  const username = from.username ? `@${from.username}` : from.first_name || String(from.id);

  try {
    await ctx.forwardMessage(config.adminId);
    await ctx.telegram.sendMessage(
      config.adminId,
      `Сообщение от ${username} (${from.id}).\nОтветь reply на сообщение выше.`,
    );
    await ctx.reply('Сообщение отправлено. Мы ответим в ближайшее время.');
  } catch {
    await ctx.reply('Не удалось отправить сообщение. Попробуй позже.');
  }
}

// --- Admin reply to user ---

export async function handleAdminReply(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || from.id !== config.adminId) return;

  const reply = ctx.message && 'reply_to_message' in ctx.message ? ctx.message.reply_to_message : null;
  if (!reply || !('forward_from' in reply)) return;

  const targetId = (reply as { forward_from?: { id: number } }).forward_from?.id;
  if (!targetId) return;

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : null;
  if (!text) return;

  try {
    await ctx.telegram.sendMessage(targetId, `Ответ поддержки:\n${text}`);
    await ctx.reply('Ответ отправлен.');
  } catch {
    await ctx.reply('Не удалось отправить ответ. Возможно, пользователь заблокировал бота.');
  }
}

// --- /help ---

export async function handleHelp(ctx: Context): Promise<void> {
  const text = [
    'Команды:',
    '/start — Выбрать сервер и купить VPN',
    '/status — Мои подписки',
    '/keys — Ссылки для подключения',
    '/support — Написать в поддержку',
    '/help — Эта справка',
    '',
    'Как подключить:',
    '1. Скачай приложение:',
    '   Android — v2rayNG (Google Play / GitHub)',
    '   iOS — Hiddify (App Store) или Streisand',
    '2. Скопируй ссылку из /keys',
    '3. В приложении: + → Импорт из буфера',
  ].join('\n');

  await ctx.reply(text);
}
