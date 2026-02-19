import cron from 'node-cron';
import type { Telegraf } from 'telegraf';
import { config } from './config';
import { logger } from './logger';
import {
  getExpiredSubscriptions, deactivateSubscription,
  expireOldPayments, getServers, createAlert,
} from './database';
import { removeClient, healthCheckAll } from './vpn-manager';

const tasks: cron.ScheduledTask[] = [];

export function startCronJobs(bot: Telegraf): void {
  // Every minute: check expired subscriptions
  tasks.push(cron.schedule('*/1 * * * *', async () => {
    try {
      const expired = getExpiredSubscriptions();
      for (const sub of expired) {
        try {
          await removeClient(sub.server_code, sub.client_uuid);
        } catch (err) {
          logger.error({ error: (err as Error).message, subId: sub.id }, 'Failed to remove expired client');
        }
        deactivateSubscription(sub.id);

        try {
          await bot.telegram.sendMessage(
            sub.telegram_id,
            `Подписка ${sub.server_emoji} ${sub.server_name} истекла.\nКупить новую: /start`,
          );
        } catch {
          // User might have blocked the bot
        }

        logger.info({ subId: sub.id, telegramId: sub.telegram_id }, 'Expired subscription deactivated');
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Cron: expiry check failed');
    }
  }));

  // Every 10 minutes: health check all servers
  tasks.push(cron.schedule('*/10 * * * *', async () => {
    try {
      const results = await healthCheckAll();
      const servers = getServers();

      for (const srv of servers) {
        const ok = results.get(srv.code);
        if (!ok) {
          const msg = `Server ${srv.emoji} ${srv.name} (${srv.code}) is DOWN`;
          logger.warn(msg);
          createAlert('server_down', msg);

          try {
            await bot.telegram.sendMessage(config.adminId, `[ALERT] ${msg}`);
          } catch {
            // Admin might be unreachable
          }
        }
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Cron: health check failed');
    }
  }));

  // Every hour: expire old pending payments
  tasks.push(cron.schedule('0 * * * *', () => {
    try {
      const count = expireOldPayments();
      if (count > 0) {
        logger.info({ count }, 'Expired old pending payments');
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Cron: expire payments failed');
    }
  }));

  logger.info('Cron jobs started');
}

export function stopCronJobs(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
  logger.info('Cron jobs stopped');
}
