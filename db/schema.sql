-- ============================================================
--  VALLÉ WHATSAPP BOT — POSTGRES SCHEMA
--  Run once:  psql "$DATABASE_URL" -f db/schema.sql
--  (or: npm run migrate)
-- ============================================================

CREATE TABLE IF NOT EXISTS contacts (
  id              BIGSERIAL PRIMARY KEY,
  wa_id           TEXT UNIQUE NOT NULL,          -- e.g. '23057123456'
  profile_name    TEXT,
  lang            TEXT DEFAULT 'en',             -- en | fr
  -- 'bot'     : AI answers automatically
  -- 'waiting' : customer asked for a human, nobody has claimed yet
  -- 'human'   : an agent has claimed and is chatting
  -- 'paused'  : bot muted for this contact, no auto replies at all
  mode            TEXT NOT NULL DEFAULT 'bot',
  -- true once the guest explicitly asked to speak to a person. The chat stays
  -- in the queue so the team sees it, but the bot answers nothing at all until
  -- a colleague replies or releases it.
  bot_silent      BOOLEAN NOT NULL DEFAULT false,
  email           TEXT,                          -- given by the guest, never by WhatsApp
  email_at        TIMESTAMPTZ,                   -- when the overview was mailed
  sms_at          TIMESTAMPTZ,                   -- when the welcome SMS went out
  awaiting        TEXT,                          -- what we asked for: 'email' or null
  claimed_by      TEXT,                          -- wa_id of the agent handling it
  claimed_at      TIMESTAMPTZ,
  source          TEXT,                          -- which QR was scanned: reception / zipline / flyer...
  last_seen_at    TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- For databases created before these columns existed.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS bot_silent BOOLEAN NOT NULL DEFAULT false;
-- The one thing WhatsApp never gives us, so the guest has to offer it.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_at TIMESTAMPTZ;
-- What we asked the guest for and are still waiting on, e.g. 'email'.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS awaiting TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_mode ON contacts(mode);
CREATE INDEX IF NOT EXISTS idx_contacts_claimed ON contacts(claimed_by);

CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  contact_id    BIGINT REFERENCES contacts(id) ON DELETE CASCADE,
  wa_message_id TEXT UNIQUE,                     -- Meta's id, used for idempotency
  direction     TEXT NOT NULL,                   -- 'in' | 'out'
  -- 'customer' | 'bot' | 'agent' | 'system'
  author        TEXT NOT NULL,
  author_wa_id  TEXT,                            -- which agent, when author='agent'
  body          TEXT,
  msg_type      TEXT DEFAULT 'text',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, created_at DESC);

-- Staff who can drive the back office from their own WhatsApp
CREATE TABLE IF NOT EXISTS agents (
  id            BIGSERIAL PRIMARY KEY,
  wa_id         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT DEFAULT 'agent',            -- agent | manager
  active        BOOLEAN DEFAULT true,
  -- the contact this agent is currently relaying messages to
  active_chat   TEXT,
  last_alert_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Free-text notes an agent leaves on a customer (visible via #info)
CREATE TABLE IF NOT EXISTS notes (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT REFERENCES contacts(id) ON DELETE CASCADE,
  agent_wa_id TEXT,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Booking intents the AI captures — your sales pipeline
CREATE TABLE IF NOT EXISTS leads (
  id           BIGSERIAL PRIMARY KEY,
  contact_id   BIGINT REFERENCES contacts(id) ON DELETE CASCADE,
  full_name    TEXT,
  pax          INT,
  visit_date   TEXT,
  interest     TEXT,                             -- 'Sky Pulse + Quad Adventure'
  status       TEXT DEFAULT 'new',               -- new | contacted | confirmed | lost
  raw          JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, created_at DESC);

-- Global kill switch + settings, editable from WhatsApp with #botoff / #boton
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('bot_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;
