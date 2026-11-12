const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function parse(iso: string): Date {
  // Date-only strings are interpreted as local dates to avoid TZ drift.
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  if (iso.length > 10) {
    const [hh, mm] = iso.slice(11, 16).split(':').map(Number);
    date.setHours(hh ?? 0, mm ?? 0);
  }
  return date;
}

export function formatDateLong(iso: string): string {
  const d = parse(iso);
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDateShort(iso: string): string {
  const d = parse(iso);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

export function weekday(iso: string): string {
  return WEEKDAYS[parse(iso).getDay()] ?? '';
}

export function formatTime(iso: string): string {
  const d = parse(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

export function relativeDay(iso: string, asOf: string): string {
  const diff = daysBetween(iso.slice(0, 10), asOf);
  if (diff <= 0) return 'сегодня';
  if (diff === 1) return 'вчера';
  return `${diff} ${plural(diff, 'день', 'дня', 'дней')} назад`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function pct(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

/** Headline fragment for human-verified payments. Never hardcoded: derived from the count. */
export function verifiedPaymentsPhrase(n: number): string {
  if (n <= 0) return 'ни одной подтверждённой оплаты';
  return `${n} ${plural(n, 'подтверждённая оплата', 'подтверждённые оплаты', 'подтверждённых оплат')}`;
}
