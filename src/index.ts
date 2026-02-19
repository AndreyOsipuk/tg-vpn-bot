import { logger } from './logger';
import { startBot } from './bot';

logger.info('=== tg-vpn-bot starting ===');

startBot().catch(err => {
  logger.fatal({ error: (err as Error).message }, 'Failed to start bot');
  process.exit(1);
});
