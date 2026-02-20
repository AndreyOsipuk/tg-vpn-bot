import { Telegraf } from 'telegraf';
import { config } from './config';
import { logger } from './logger';
import {
  handleStart, handleServerSelect, handleBackToServers,
  handleBuy, handleCheckPayment, handleStatus, handleKeys, handleShowKeys, handleApps, handleHelp,
  handleSupport, handleUserMessage, handleAdminReply,
} from './handlers';
import {
  handleAdmin, handleStats, handleUsers,
  handleHealth, handleToggleSales, handleBlock, handleBroadcast,
} from './admin';
import { setBotInstance, startPolling, stopPayments } from './payments';
import { startCronJobs, stopCronJobs } from './cron';
import { closeDb } from './database';

// Rate limiting: track last command time per user
const rateLimits = new Map<number, number>();
const RATE_LIMIT_MS = 1000; // 1 second between commands

function isRateLimited(userId: number): boolean {
  const now = Date.now();
  const last = rateLimits.get(userId);
  if (last && now - last < RATE_LIMIT_MS) {
    return true;
  }
  rateLimits.set(userId, now);
  return false;
}

// Clean up rate limit map periodically
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [id, ts] of rateLimits) {
    if (ts < cutoff) rateLimits.delete(id);
  }
}, 60_000);

export function createBot(): Telegraf {
  const bot = new Telegraf(config.botToken);

  // Pass bot instance to payments module
  setBotInstance(bot);

  // Rate limiting middleware
  bot.use(async (ctx, next) => {
    if (ctx.from && isRateLimited(ctx.from.id)) {
      return; // silently drop
    }
    return next();
  });

  // User commands
  bot.start(handleStart);
  bot.command('status', handleStatus);
  bot.command('keys', handleKeys);
  bot.command('apps', handleApps);
  bot.command('support', handleSupport);
  bot.command('help', handleHelp);

  // Admin commands
  bot.command('admin', handleAdmin);
  bot.command('stats', handleStats);
  bot.command('users', handleUsers);
  bot.command('health', handleHealth);
  bot.command('toggle_sales', handleToggleSales);
  bot.command('block', handleBlock);
  bot.command('broadcast', (ctx) => handleBroadcast(ctx, bot));

  // Callback queries
  bot.action(/^server:/, handleServerSelect);
  bot.action('back_to_servers', handleBackToServers);
  bot.action(/^buy:/, handleBuy);
  bot.action(/^check:/, handleCheckPayment);
  bot.action('show_keys', handleShowKeys);

  // Admin callback queries
  bot.action('adm:stats', handleStats);
  bot.action('adm:users', handleUsers);
  bot.action('adm:health', handleHealth);
  bot.action('adm:toggle_sales', handleToggleSales);

  // Admin reply to forwarded messages
  bot.on('message', (ctx, next) => {
    if (ctx.from?.id === config.adminId && ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
      return handleAdminReply(ctx);
    }
    return next();
  });

  // Forward user messages to admin (support)
  bot.on('message', handleUserMessage);

  // Error handler
  bot.catch((err, ctx) => {
    logger.error({ error: (err as Error).message, updateType: ctx.updateType }, 'Bot error');
  });

  return bot;
}

export async function startBot(): Promise<Telegraf> {
  const bot = createBot();

  // Start YooMoney payment polling (every 15s)
  startPolling();

  // Start cron jobs
  startCronJobs(bot);

  // Launch bot
  await bot.launch();

  // Set commands for regular users
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Выбрать локацию и тариф' },
    { command: 'status', description: 'Мои подписки' },
    { command: 'keys', description: 'Мои ключи подключения' },
    { command: 'apps', description: 'Скачать приложение' },
    { command: 'support', description: 'Написать в поддержку' },
    { command: 'help', description: 'Помощь' },
  ]);

  // Set commands for admin (includes admin commands)
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Выбрать локацию и тариф' },
    { command: 'status', description: 'Мои подписки' },
    { command: 'keys', description: 'Мои ключи подключения' },
    { command: 'apps', description: 'Скачать приложение' },
    { command: 'support', description: 'Написать в поддержку' },
    { command: 'help', description: 'Помощь' },
    { command: 'admin', description: '🔧 Админ-панель' },
    { command: 'stats', description: '🔧 Статистика' },
    { command: 'health', description: '🔧 Проверка серверов' },
    { command: 'users', description: '🔧 Список юзеров' },
    { command: 'broadcast', description: '🔧 Рассылка' },
  ], { scope: { type: 'chat', chat_id: config.adminId } });

  logger.info('Bot started');

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    bot.stop(signal);
    stopCronJobs();
    stopPayments();
    closeDb();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return bot;
}
