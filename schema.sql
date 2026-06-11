CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey     TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    completed  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    user_id    INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pubkey_user_id_unique ON todos(pubkey, user_id);
