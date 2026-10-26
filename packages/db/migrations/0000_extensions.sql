-- Case-insensitive text, used for e-mail addresses and user names from J1 on.
-- citext is a trusted extension, so the database owner can create it without superuser rights.
CREATE EXTENSION IF NOT EXISTS citext;
