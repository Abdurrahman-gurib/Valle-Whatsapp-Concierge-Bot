/**
 * VOICE TRANSCRIPTION — turns WhatsApp voice notes into text.
 *
 * Uses OpenAI Whisper (multilingual: French, Creole, Arabic, Hindi, Chinese,
 * Russian, German, Spanish, Portuguese, Turkish, Polish, Japanese, Swahili...).
 * Requires OPENAI_API_KEY in .env; without it, transcribeAudio() returns null
 * and the router falls back to handing the voice note to the team.
 */
import { config } from '../core/config.js';

/**
 * Turn a reply into speech (any language — the voice follows the text).
 * Returns an OGG/Opus buffer WhatsApp renders as a voice note, or null.
 */
export async function synthesizeSpeech(text) {
  if (!config.stt.openaiKey || !text) return null;

  // Strip WhatsApp formatting so it isn't read out loud.
  const speakable = text
    .replace(/[*_~`•]/g, '')
    .replace(/\n+/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 2000);

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stt.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input: speakable,
      response_format: 'opus',
      instructions: 'Warm, professional park concierge. Match the language of the text exactly.',
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error('[tts] failed', res.status, err.slice(0, 200));
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  if (!config.stt.openaiKey) return null;

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType.split(';')[0] }), 'voice.ogg');
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.stt.openaiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error('[transcribe] failed', res.status, err.slice(0, 200));
    return null;
  }

  const data = await res.json();
  return data.text || null;
}
