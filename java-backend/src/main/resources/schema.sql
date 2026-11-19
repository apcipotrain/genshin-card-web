CREATE TABLE IF NOT EXISTS accounts (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(12) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    nickname VARCHAR(12) NOT NULL,
    avatar CLOB NOT NULL,
    exp BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    pve_stars CLOB NOT NULL,
    settings CLOB NOT NULL,
    stats CLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL REFERENCES accounts(id),
    expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON account_sessions(expires_at);
CREATE TABLE IF NOT EXISTS account_operations (
    account_id VARCHAR(64) NOT NULL REFERENCES accounts(id),
    operation_id VARCHAR(128) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    result CLOB NOT NULL,
    PRIMARY KEY(account_id, operation_id)
);
