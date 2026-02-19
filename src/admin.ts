import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { config } from './config';
import { logger } from './logger';
import {
  getServers, getAllUsers, getActiveSubscriptions,
  getAllActiveSubscriptions, deactivateAllUserSubscriptions,
  blockUser, getPaymentStats, getActiveUserIds,
  countActiveSubscriptionsByServer,
} from './database';
import { healthCheckAll, removeClient } from './vpn-manager';
import { toggleSales, salesBlocked } from './payments';
import type { Telegraf } from 'telegraf';

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === config.adminId;
}

// --- /admin ---

export async function handleAdmin(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) return;

  await ctx.reply(
    'Админ-панель:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Статистика', 'adm:stats')],
      [Markup.button.callback('Юзеры', 'adm:users')],
      [Markup.button.callback('Health Check', 'adm:health')],
      [Markup.button.callback(salesBlocked ? 'Включить продажи' : 'Выключить продажи', 'adm:toggle_sales')],
    ]),
  );
}

// --- Stats ---

export async function handleStats(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) return;

  const servers = getServers();
  const allUsers = getAllUsers();
  const { total_revenue, total_payments } = getPaymentStats();

  const lines: string[] = [
    'Статистика:',
    '',
    `Юзеров: ${allUsers.length}`,
    `Платежей: ${total_payments}`,
    `Выручка: ${total_revenue} руб.`,
    '',
  ];

  for (const srv of servers) {
    const count = countActiveSubscriptionsByServer(srv.id);
    lines.push(`${srv.emoji} ${srv.name}: ${count}/${srv.max_users} подписок`);
  }

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    await ctx.editMessageText(lines.join('\n'));
  } else {
    await ctx.reply(lines.join('\n'));
  }
}

// --- Users list ---

export async function handleUsers(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) return;

  const subs = getAllActiveSubscriptions();
  if (subs.length === 0) {
    const text = 'Нет активных подписок';
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery();
      await ctx.editMessageText(text);
    } else {
      await ctx.reply(text);
    }
    return;
  }

  // Group by telegram_id
  const byUser = new Map<number, typeof subs>();
  for (const s of subs) {
    const list = byUser.get(s.telegram_id) || [];
    list.push(s);
    byUser.set(s.telegram_id, list);
  }

  const lines: string[] = [`Активные юзеры (${byUser.size}):`];

  for (const [tgId, userSubs] of byUser) {
    const subList = userSubs.map(s => `${s.server_emoji}${s.tariff_id}`).join(', ');
    lines.push(`  ${tgId}: ${subList}`);
  }

  const text = lines.join('\n').slice(0, 4000);

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    await ctx.editMessageText(text);
  } else {
    await ctx.reply(text);
  }
}

// --- Health check ---

export async function handleHealth(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) return;

  if (ctx.callbackQuery) await ctx.answerCbQuery('Проверяю...');

  const results = await healthCheckAll();
  const servers = getServers();

  const lines: string[] = ['Health Check:'];
  for (const srv of servers) {
    const ok = results.get(srv.code);
    const status = ok ? 'ONLINE' : 'OFFLINE';
    lines.push(`${srv.emoji} ${srv.name}: ${status}`);
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(lines.join('\n'));
  } else {
    await ctx.reply(lines.join('\n'));
  }
}

// --- Toggle sales ---

export async function handleToggleSales(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) return;

  const blocked = toggleSales();
  const text = blocked ? 'Продажи ВЫКЛЮЧЕНЫ' : 'Продажи ВКЛЮЧЕНЫ';

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(text);
    await handleAdmin(ctx);
  } else {
    await ctx.reply(text);
  }
}

// --- /block <telegram_id> ---

export async function handleBlock(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) return;

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
  const parts = text.split(' ');
  if (parts.length < 2) {
    await ctx.reply('Использование: /block <telegram_id>');
    return;
  }

  const targetId = parseInt(parts[1], 10);
  if (isNaN(targetId)) {
    await ctx.reply('Неверный ID');
    return;
  }

  // Deactivate all subscriptions and remove from 3X-UI
  const subs = deactivateAllUserSubscriptions(targetId);
  for (const sub of subs) {
    try {
      const servers = getServers();
      const srv = servers.find(s => s.id === sub.server_id);
      if (srv) {
        await removeClient(srv.code, sub.client_uuid);
      }
    } catch (err) {
      logger.error({ error: (err as Error).message, subId: sub.id }, 'Failed to remove client during block');
    }
  }

  blockUser(targetId);
  await ctx.reply(`Юзер ${targetId} заблокирован. Удалено подписок: ${subs.length}`);
}

// --- /broadcast <text> ---

export async function handleBroadcast(ctx: Context, bot: Telegraf): Promise<void> {
  if (!isAdmin(ctx)) return;

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
  const content = text.replace(/^\/broadcast\s*/, '').trim();

  if (!content) {
    await ctx.reply('Использование: /broadcast <текст сообщения>');
    return;
  }

  const userIds = getActiveUserIds();
  let sent = 0;
  let failed = 0;

  for (const id of userIds) {
    try {
      await bot.telegram.sendMessage(id, content);
      sent++;
    } catch {
      failed++;
    }
  }

  await ctx.reply(`Рассылка завершена: ${sent} доставлено, ${failed} ошибок`);
}
