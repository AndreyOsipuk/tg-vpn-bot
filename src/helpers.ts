const MONTHS_RU = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

export function formatDate(iso: string): string {
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const day = d.getUTCDate();
  const month = MONTHS_RU[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} ${hours}:${minutes}`;
}

export function formatTimeLeft(iso: string): string {
  const now = Date.now();
  const expires = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  const diff = expires - now;

  if (diff <= 0) return 'истекла';

  const totalMinutes = Math.floor(diff / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days} дн. ${hours} ч.`;
  if (hours > 0) return `${hours} ч. ${minutes} мин.`;
  return `${minutes} мин.`;
}

export function formatTraffic(bytes: number): string {
  if (bytes === 0) return '0 Б';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} ГБ`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} КБ`;
}

export function gbToBytes(gb: number): number {
  return gb * 1024 * 1024 * 1024;
}

export function trafficBar(used: number, limit: number, barLength = 16): string {
  if (limit === 0) return '';
  const pct = Math.min(used / limit, 1);
  const filled = Math.round(pct * barLength);
  const empty = barLength - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  return `${bar} ${Math.round(pct * 100)}%`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
