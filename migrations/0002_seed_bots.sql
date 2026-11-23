-- House bots. Their versions and ratings are created by the cron for each new season.
INSERT INTO users (id, google_sub, email, display_name, is_admin, is_bot, banned, created_at) VALUES
  ('bot-guard',     NULL, NULL, 'בוט הבית: שומר',   0, 1, 0, 1767225600000),
  ('bot-chatter',   NULL, NULL, 'בוט הבית: פטפטן',  0, 1, 0, 1767225600000),
  ('bot-trickster', NULL, NULL, 'בוט הבית: ערמומי', 0, 1, 0, 1767225600000);
