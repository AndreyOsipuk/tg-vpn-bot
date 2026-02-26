/**
 * One-time script: create permanent VPN subscriptions for admin
 * Usage: npx tsx scripts/grant-admin.ts
 */
import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../src/config';
import { upsertUser, createSubscription, getServers } from '../src/database';
import { addClient, buildVlessLink } from '../src/vpn-manager';

const ADMIN_ID = config.adminId;
const MAX_DEVICES = 5;
// 100 years from now
const EXPIRES_AT = new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000);

async function main() {
  console.log(`\nCreating permanent VPN for admin ${ADMIN_ID}...\n`);

  // Ensure admin user exists in DB
  upsertUser(ADMIN_ID, 'admin', 'Admin');

  const servers = getServers();

  for (const server of servers) {
    const uuid = uuidv4();
    const email = `admin_${ADMIN_ID}_${server.code}`;

    // Add client to 3X-UI with expiryTime=0 (never expires)
    await addClient(
      server.code,
      uuid,
      email,
      MAX_DEVICES,
      0, // traffic: unlimited
      0, // expiryTime: 0 = never expires
    );

    // Save to DB
    createSubscription(
      ADMIN_ID,
      server.id,
      uuid,
      email,
      'year', // tariff_id placeholder
      EXPIRES_AT.toISOString(),
      MAX_DEVICES,
      0,
    );

    const label = `ADMIN-${server.code.toUpperCase()}`;
    const link = buildVlessLink(server.code, uuid, label);

    console.log(`${server.emoji} ${server.name}:`);
    console.log(link);
    console.log('');
  }

  console.log('Done! Links are also available via /keys in the bot.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
