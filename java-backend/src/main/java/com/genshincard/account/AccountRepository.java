package com.genshincard.account;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;

@Repository
class AccountRepository {
    private final JdbcTemplate jdbc;
    private final JsonMapper json;

    AccountRepository(JdbcTemplate jdbc, JsonMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    private AccountData row(ResultSet rs, int ignored) throws SQLException {
        return new AccountData(rs.getString("id"), rs.getString("name"), rs.getString("password_hash"),
                rs.getString("nickname"), rs.getString("avatar"), rs.getLong("exp"), rs.getLong("created_at"),
                json.readValue(rs.getString("pve_stars"), new TypeReference<Map<String, Integer>>() {}),
                json.readValue(rs.getString("settings"), new TypeReference<Map<String, Object>>() {}),
                json.readValue(rs.getString("stats"), new TypeReference<Map<String, Object>>() {}));
    }

    AccountData findById(String id, boolean lock) {
        List<AccountData> rows = jdbc.query("SELECT * FROM accounts WHERE id=?" + (lock ? " FOR UPDATE" : ""), this::row, id);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    AccountData findByName(String name, boolean lock) {
        List<AccountData> rows = jdbc.query("SELECT * FROM accounts WHERE name=?" + (lock ? " FOR UPDATE" : ""), this::row, name);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    void insert(AccountData a) {
        jdbc.update("INSERT INTO accounts(id,name,password_hash,nickname,avatar,exp,created_at,pve_stars,settings,stats) VALUES(?,?,?,?,?,?,?,?,?,?)",
                a.id(), a.name(), a.passwordHash(), a.nickname(), a.avatar(), a.exp(), a.createdAt(),
                json.writeValueAsString(a.pveStars()), json.writeValueAsString(a.settings()), json.writeValueAsString(a.stats()));
    }

    void update(AccountData a) {
        jdbc.update("UPDATE accounts SET password_hash=?,nickname=?,avatar=?,exp=?,pve_stars=?,settings=?,stats=? WHERE id=?",
                a.passwordHash(), a.nickname(), a.avatar(), a.exp(), json.writeValueAsString(a.pveStars()),
                json.writeValueAsString(a.settings()), json.writeValueAsString(a.stats()), a.id());
    }

    void createSession(String hash, String accountId, long expiresAt) {
        jdbc.update("DELETE FROM account_sessions WHERE expires_at<=?", System.currentTimeMillis());
        jdbc.update("INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES(?,?,?)", hash, accountId, expiresAt);
    }

    String sessionAccount(String hash) {
        List<String> rows = jdbc.queryForList("SELECT account_id FROM account_sessions WHERE token_hash=? AND expires_at>?", String.class, hash, System.currentTimeMillis());
        return rows.isEmpty() ? null : rows.getFirst();
    }

    void revoke(String hash) {
        jdbc.update("DELETE FROM account_sessions WHERE token_hash=?", hash);
    }

    Map<String, Object> previousOperation(String accountId, String operationId, String requestHash) {
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT request_hash,result FROM account_operations WHERE account_id=? AND operation_id=?", accountId, operationId);
        if (rows.isEmpty()) return null;
        if (!requestHash.equals(rows.getFirst().get("REQUEST_HASH"))) throw new ApiException(409, "该操作编号已用于不同的结算");
        // CLOB's Java representation depends on the driver; query through a string row mapper.
        return jdbc.queryForObject("SELECT result FROM account_operations WHERE account_id=? AND operation_id=?",
                (rs, ignored) -> json.readValue(rs.getString(1), new TypeReference<Map<String, Object>>() {}), accountId, operationId);
    }

    void rememberOperation(String accountId, String operationId, String requestHash, Map<String, Object> result) {
        jdbc.update("INSERT INTO account_operations(account_id,operation_id,request_hash,result) VALUES(?,?,?,?)",
                accountId, operationId, requestHash, json.writeValueAsString(result));
    }
}
