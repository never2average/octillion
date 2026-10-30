/**
 * GTM › Campaigns: when an email may go out (src/campaigns.ts). A campaign's send window is days of the week and local
 * hours, read in the recipient's own time zone:
 *
 *   time zone   the one stored for the person (a Clerk membership's public_metadata.time_zone, when someone set it:
 *               Clerk has no time zone field of its own), else the main zone of the country their access request came
 *               from (access_requests.source.country, Vercel's IP country), else the campaign's default zone
 *   window      {days: [1..7] (ISO: 1 = Monday), start_hour, end_hour (exclusive), time_zone}; no days = any time
 *   due outside a step waits for the next opening (nextOpening); nothing is sent at 3am because a delay ran out then
 *
 * Countries spanning several zones get their most populous one (US: New York, Canada: Toronto, Australia: Sydney,
 * Brazil: São Paulo, Russia: Moscow, Mexico: Mexico City, Indonesia: Jakarta). Unknown countries use the default.
 */

export interface SendWindow { days: number[]; start_hour: number; end_hour: number; time_zone: string }
export const NO_WINDOW: SendWindow = { days: [], start_hour: 0, end_hour: 24, time_zone: "UTC" };

/** A real IANA zone this runtime knows (Intl refuses anything else). */
export function validZone(z: unknown): z is string {
  if (typeof z !== "string" || !z || z.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; }
}

/** The country's main time zone (ISO 3166 alpha-2), or null. */
export const COUNTRY_ZONE: Record<string, string> = {
  US: "America/New_York", CA: "America/Toronto", MX: "America/Mexico_City", BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires", CL: "America/Santiago",
  CO: "America/Bogota", PE: "America/Lima", VE: "America/Caracas", UY: "America/Montevideo", PY: "America/Asuncion", BO: "America/La_Paz", EC: "America/Guayaquil",
  CR: "America/Costa_Rica", PA: "America/Panama", GT: "America/Guatemala", DO: "America/Santo_Domingo", PR: "America/Puerto_Rico", JM: "America/Jamaica",
  GB: "Europe/London", IE: "Europe/Dublin", IM: "Europe/Isle_of_Man", JE: "Europe/Jersey", GG: "Europe/Guernsey", PT: "Europe/Lisbon", ES: "Europe/Madrid",
  FR: "Europe/Paris", BE: "Europe/Brussels", NL: "Europe/Amsterdam", LU: "Europe/Luxembourg", DE: "Europe/Berlin", CH: "Europe/Zurich", AT: "Europe/Vienna",
  IT: "Europe/Rome", MT: "Europe/Malta", DK: "Europe/Copenhagen", NO: "Europe/Oslo", SE: "Europe/Stockholm", FI: "Europe/Helsinki", IS: "Atlantic/Reykjavik",
  EE: "Europe/Tallinn", LV: "Europe/Riga", LT: "Europe/Vilnius", PL: "Europe/Warsaw", CZ: "Europe/Prague", SK: "Europe/Bratislava", HU: "Europe/Budapest",
  SI: "Europe/Ljubljana", HR: "Europe/Zagreb", RO: "Europe/Bucharest", BG: "Europe/Sofia", GR: "Europe/Athens", CY: "Asia/Nicosia", LI: "Europe/Vaduz",
  RS: "Europe/Belgrade", BA: "Europe/Sarajevo", ME: "Europe/Podgorica", MK: "Europe/Skopje", AL: "Europe/Tirane", MD: "Europe/Chisinau", UA: "Europe/Kyiv",
  BY: "Europe/Minsk", RU: "Europe/Moscow", TR: "Europe/Istanbul", GE: "Asia/Tbilisi", AM: "Asia/Yerevan", AZ: "Asia/Baku",
  IL: "Asia/Jerusalem", AE: "Asia/Dubai", SA: "Asia/Riyadh", QA: "Asia/Qatar", KW: "Asia/Kuwait", BH: "Asia/Bahrain", OM: "Asia/Muscat", JO: "Asia/Amman",
  LB: "Asia/Beirut", EG: "Africa/Cairo", MA: "Africa/Casablanca", TN: "Africa/Tunis", DZ: "Africa/Algiers", NG: "Africa/Lagos", GH: "Africa/Accra",
  KE: "Africa/Nairobi", ET: "Africa/Addis_Ababa", UG: "Africa/Kampala", TZ: "Africa/Dar_es_Salaam", RW: "Africa/Kigali", ZA: "Africa/Johannesburg", SN: "Africa/Dakar",
  IN: "Asia/Kolkata", PK: "Asia/Karachi", BD: "Asia/Dhaka", LK: "Asia/Colombo", NP: "Asia/Kathmandu", KZ: "Asia/Almaty", UZ: "Asia/Tashkent",
  CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", TW: "Asia/Taipei", JP: "Asia/Tokyo", KR: "Asia/Seoul", SG: "Asia/Singapore", MY: "Asia/Kuala_Lumpur",
  TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", PH: "Asia/Manila", ID: "Asia/Jakarta", AU: "Australia/Sydney", NZ: "Pacific/Auckland",
};

/** The zone a recipient's window is read in: stored, else the country's, else the campaign default. */
export function recipientZone(stored: string | null | undefined, country: string | null | undefined, fallback: string): string {
  if (validZone(stored)) return stored;
  const z = country ? COUNTRY_ZONE[country.toUpperCase()] : undefined;
  return z && validZone(z) ? z : validZone(fallback) ? fallback : "UTC";
}

const fmts = new Map<string, Intl.DateTimeFormat>();
/** ISO weekday (1 = Monday) and the hour, in the zone. */
export function localParts(t: Date, zone: string): { day: number; hour: number; minute: number } {
  let f = fmts.get(zone);
  if (!f) fmts.set(zone, f = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }));
  const parts = Object.fromEntries(f.formatToParts(t).map((p) => [p.type, p.value]));
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { day, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

export const windowOpen = (w: SendWindow, t: Date, zone: string) => {
  if (!w.days.length) return true;
  const p = localParts(t, zone);
  return w.days.includes(p.day) && p.hour >= w.start_hour && p.hour < w.end_hour;
};

/**
 * The first moment at or after `from` inside the window, in the zone. Walks forward a quarter of an hour at a time
 * (zones are offset by whole quarters), at most 8 days; a window that never opens (cannot pass parseWindow) gives `from`.
 */
export function nextOpening(w: SendWindow, from: Date, zone: string): Date {
  if (!w.days.length || windowOpen(w, from, zone)) return from;
  const q = 15 * 60_000;
  let t = new Date(Math.ceil(from.getTime() / q) * q);
  for (let i = 0; i < 8 * 96; i++, t = new Date(t.getTime() + q)) if (windowOpen(w, t, zone)) return t;
  return from;
}

/** Checked {days, start_hour, end_hour, time_zone}; anything empty is "any time". Throws a message for the editor. */
export function parseWindow(v: unknown, fail: (msg: string) => never): SendWindow {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const days = [...new Set((Array.isArray(o.days) ? o.days : []).map(Number))].sort();
  if (!days.length) return { ...NO_WINDOW, time_zone: validZone(o.time_zone) ? o.time_zone : "UTC" };
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) fail("send_window.days are ISO weekdays, 1 (Monday) to 7 (Sunday)");
  const start = o.start_hour == null || o.start_hour === "" ? 9 : Number(o.start_hour), end = o.end_hour == null || o.end_hour === "" ? 17 : Number(o.end_hour);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) fail("send_window hours: start_hour 0 to 23, end_hour after it, up to 24");
  const zone = o.time_zone == null || o.time_zone === "" ? "UTC" : o.time_zone;
  if (!validZone(zone)) fail(`send_window.time_zone ${String(zone)} is not a time zone (use an IANA name, e.g. Europe/Berlin)`);
  return { days, start_hour: start, end_hour: end, time_zone: zone as string };
}
