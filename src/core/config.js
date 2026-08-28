import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  env: process.env.NODE_ENV || 'development',

  wa: {
    // Provider: 'meta' = direct Cloud API (needs WHATSAPP_TOKEN + PHONE_NUMBER_ID).
    // 'd360' = via 360dialog gateway (coexistence) — activates automatically
    // when D360_API_KEY is set.
    provider: process.env.D360_API_KEY ? 'd360' : 'meta',
    d360ApiKey: process.env.D360_API_KEY || '',
    token: required('WHATSAPP_TOKEN'),
    phoneNumberId: required('PHONE_NUMBER_ID'),
    wabaId: process.env.WABA_ID || '',
    version: process.env.GRAPH_API_VERSION || 'v24.0',
    verifyToken: required('VERIFY_TOKEN'),
    appSecret: required('APP_SECRET'),
    businessNumber: process.env.BUSINESS_NUMBER || '23052928841',
    agentAlertTemplate: process.env.AGENT_ALERT_TEMPLATE || '',
    agentAlertTemplateLang: process.env.AGENT_ALERT_TEMPLATE_LANG || 'en',
  },

  // Optional: enables voice-note transcription (OpenAI Whisper).
  // Empty = voice notes get a polite reply and are handed to the team.
  stt: {
    openaiKey: process.env.OPENAI_API_KEY || '',
  },

  ai: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
    maxTokens: Number(process.env.CLAUDE_MAX_TOKENS || 700),
  },

  // Optional: a welcome SMS to guests who scan the ATM Dubai QR code (Twilio).
  // Empty credentials = no SMS is ever sent, and nothing else changes.
  sms: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    // Either a Twilio number in E.164, or a Messaging Service (recommended:
    // it carries the registered sender IDs the Gulf operators require).
    from: process.env.TWILIO_FROM || '',
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
    // A hard off switch that leaves the credentials in place.
    enabled: String(process.env.SMS_ENABLED ?? 'true').toLowerCase() === 'true',
  },

  // Optional: the park overview by email (Resend).
  // Empty API key = the bot never offers or sends email.
  email: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || '',
    replyTo: process.env.EMAIL_REPLY_TO || '',
    // Comma separated. CC is visible to the guest (the sales desk); BCC is
    // not (the people who want to see every lead land).
    cc: process.env.EMAIL_CC || '',
    bcc: process.env.EMAIL_BCC || '',
  },

  // Secret key for the read-only web dashboard (/dashboard?key=...).
  // Empty = dashboard disabled.
  dashboardKey: process.env.DASHBOARD_KEY || '',

  db: {
    url: required('DATABASE_URL'),
    ssl: String(process.env.DB_SSL).toLowerCase() === 'true',
  },

  bot: {
    // 'menu'   = deterministic keyword/menu bot, fixed replies, no AI calls.
    // 'hybrid' = menus & price cards first, AI answers any other free text.
    // 'ai'     = Claude concierge for everything (original behaviour).
    mode: (process.env.BOT_MODE || 'hybrid').toLowerCase(),
    // When true, the bot only answers guests whose first message came from a
    // QR deep link (matches a QR_SOURCES pattern). Everyone else is logged
    // silently. Set QR_ONLY=false to answer anyone who messages the number.
    qrOnly: String(process.env.QR_ONLY ?? 'true').toLowerCase() === 'true',
    adminNumbers: (process.env.ADMIN_NUMBERS || '')
      .split(',')
      .map((s) => s.trim().replace(/\D/g, ''))
      .filter(Boolean),
    handoverTimeoutMin: Number(process.env.HANDOVER_TIMEOUT_MIN || 30),
    // Minutes of colleague silence before a chat a HUMAN is handling returns to
    // the bot. 0 (the default) means never: once a person answers a guest, the
    // bot stays out until someone releases the chat with #release.
    humanTakeoverMinutes: Number(process.env.HUMAN_TAKEOVER_MINUTES || 0),
    // A guest who scans a QR code restarts the concierge, provided no colleague
    // has written to them in this many minutes. Protects a live conversation
    // while letting a returning guest reach the assistant again.
    qrReactivateMinutes: Number(process.env.QR_REACTIVATE_MINUTES || 60),
    openHour: Number(process.env.OPEN_HOUR || 9),
    closeHour: Number(process.env.CLOSE_HOUR || 17),
    timezone: process.env.TIMEZONE || 'Indian/Mauritius',
  },
};

/** Is the park currently open, in park local time? */
export function isBusinessHours(date = new Date()) {
  // Minutes matter: the park closes at 17:30, so OPEN_HOUR/CLOSE_HOUR accept
  // decimals (17.5 = 17:30) and the current time is compared the same way.
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.bot.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).split(':').map(Number);
  const now = h + m / 60;
  return now >= config.bot.openHour && now < config.bot.closeHour;
}
