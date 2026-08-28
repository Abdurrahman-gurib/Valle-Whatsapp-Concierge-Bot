/**
 * LIVE WEATHER AT THE PARK
 *
 * Guests ask "what's the weather like at Vallé?", "will it rain on Saturday?",
 * "is it too windy for the ziplines?". The assistant answers from real data:
 * current conditions and a three-day forecast for Chamouny, refreshed every
 * ten minutes from Open-Meteo (free, no key, ~150 calls a day at this rate).
 *
 * Never throws. On any failure it serves the last good reading for up to an
 * hour, then nothing, and the assistant simply says it cannot see the forecast.
 */

/** Chamouny, Savanne district: the park's home. */
const LAT = -20.482;
const LON = 57.466;
const TZ = 'Indian/Mauritius';

const FRESH_MS = 10 * 60 * 1000;       // reuse a reading for ten minutes
const STALE_MS = 60 * 60 * 1000;       // serve an old reading for up to an hour
const TIMEOUT_MS = 6000;

const URL = 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${LAT}&longitude=${LON}`
  + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m'
  + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_gusts_10m_max,sunrise,sunset'
  + `&timezone=${encodeURIComponent(TZ)}&forecast_days=3`;

/** WMO weather codes, in plain words. */
const CONDITIONS = [
  [[0], 'clear sky'], [[1], 'mainly clear'], [[2], 'partly cloudy'], [[3], 'overcast'],
  [[45, 48], 'fog'], [[51, 53, 55], 'light drizzle'], [[56, 57], 'freezing drizzle'],
  [[61], 'light rain'], [[63], 'moderate rain'], [[65], 'heavy rain'], [[66, 67], 'freezing rain'],
  [[71, 73, 75, 77], 'snow'], [[80], 'light rain showers'], [[81], 'rain showers'],
  [[82], 'heavy rain showers'], [[85, 86], 'snow showers'], [[95], 'thunderstorm'],
  [[96, 99], 'thunderstorm with hail'],
];
export const describeCode = (code) =>
  CONDITIONS.find(([codes]) => codes.includes(Number(code)))?.[1] || 'mixed conditions';

let cache = { at: 0, data: null };

/** Fetch (or reuse) the reading. Returns the parsed data or null. */
export async function getWeather({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (cache.data && now - cache.at < FRESH_MS) return cache.data;
  try {
    const res = await fetchImpl(URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json = await res.json();
    const data = parse(json);
    if (!data) throw new Error('unexpected shape');
    cache = { at: now, data };
    return data;
  } catch (err) {
    console.warn('[weather] unavailable:', err.message);
    if (cache.data && now - cache.at < STALE_MS) return cache.data;
    return null;
  }
}

function parse(j) {
  const c = j?.current;
  const d = j?.daily;
  if (!c || !d?.time?.length) return null;
  return {
    observedAt: c.time,                          // "2026-08-28T12:15" park local time
    temperature: round(c.temperature_2m),
    feelsLike: round(c.apparent_temperature),
    humidity: round(c.relative_humidity_2m),
    precipitation: c.precipitation,
    condition: describeCode(c.weather_code),
    wind: round(c.wind_speed_10m),
    gusts: round(c.wind_gusts_10m),
    days: d.time.map((date, i) => ({
      date,
      condition: describeCode(d.weather_code?.[i]),
      max: round(d.temperature_2m_max?.[i]),
      min: round(d.temperature_2m_min?.[i]),
      rainChance: round(d.precipitation_probability_max?.[i]),
      gusts: round(d.wind_gusts_10m_max?.[i]),
      sunrise: (d.sunrise?.[i] || '').slice(11, 16),
      sunset: (d.sunset?.[i] || '').slice(11, 16),
    })),
  };
}

const round = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? null : Math.round(Number(n)));

const dayName = (iso, i) => i === 0 ? 'Today'
  : new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * One compact paragraph for the assistant's context: what it is like at the
 * park right now and what the next three days look like.
 */
export function describeWeather(w) {
  if (!w) return null;
  const time = (w.observedAt || '').slice(11, 16);
  const now = `${w.temperature}°C (feels like ${w.feelsLike}°C), ${w.condition}, `
    + `wind ${w.wind} km/h with gusts to ${w.gusts} km/h, humidity ${w.humidity}%`
    + (w.precipitation > 0 ? `, ${w.precipitation} mm of rain in the last hour` : '');
  const days = w.days.map((d, i) =>
    `${dayName(d.date, i)}: ${d.condition}, ${d.min}-${d.max}°C, ${d.rainChance}% chance of rain, gusts to ${d.gusts} km/h`
  ).join(' · ');
  const sun = w.days[0] ? ` Sunrise ${w.days[0].sunrise}, sunset ${w.days[0].sunset}.` : '';
  return `Live weather at the park (Chamouny), ${time} local: ${now}. Forecast: ${days}.${sun}`;
}

/** For tests. */
export const _resetWeatherCache = () => { cache = { at: 0, data: null }; };
export const _setWeatherCache = (data, at = Date.now()) => { cache = { at, data }; };
