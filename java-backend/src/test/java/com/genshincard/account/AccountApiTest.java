package com.genshincard.account;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=jdbc:h2:mem:account-tests;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000",
        "app.game-service-key=test-game-service-secret",
        "app.legacy-accounts="
})
class AccountApiTest {
    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired JsonMapper json;
    @Autowired LegacyAccountImporter importer;
    @Autowired TransactionTemplate transactions;
    private final HttpClient client = HttpClient.newHttpClient();
    private static final String INTERNAL_KEY = "test-game-service-secret";

    record Response(int status, Map<String, Object> body) {}

    @BeforeEach
    void reset() {
        jdbc.update("DELETE FROM account_operations");
        jdbc.update("DELETE FROM account_sessions");
        jdbc.update("DELETE FROM accounts");
    }

    private Response call(String method, String path, Object body, String token, String key) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
        if (token != null) builder.header("Authorization", "Bearer " + token);
        if (key != null) builder.header("X-Game-Service-Key", key);
        if (body != null) builder.header("Content-Type", "application/json");
        builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        return new Response(response.statusCode(), json.readValue(response.body(), new TypeReference<Map<String, Object>>() {}));
    }

    private Response signup(String name) throws Exception {
        return call("POST", "/api/auth/signup", Map.of("name", name, "password", "test-password"), null, null);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> account(Response response) { return (Map<String, Object>) response.body().get("account"); }

    private String token(Response response) { return (String) response.body().get("token"); }

    @Test
    void registrationLoginAndRevocationDoNotExposeSecrets() throws Exception {
        Response registration = signup("旅行者");
        assertThat(registration.status()).isEqualTo(200);
        assertThat(account(registration)).doesNotContainKeys("passwordHash", "password", "token");
        assertThat(account(registration)).containsEntry("level", 1).containsEntry("exp", 0);
        String hash = jdbc.queryForObject("SELECT password_hash FROM accounts", String.class);
        assertThat(hash).startsWith("$2a$").isNotEqualTo("test-password");
        assertThat(jdbc.queryForObject("SELECT token_hash FROM account_sessions", String.class)).isNotEqualTo(token(registration));
        assertThat(call("GET", "/api/account", null, token(registration), null).status()).isEqualTo(200);
        assertThat(signup("旅行者").status()).isEqualTo(409);
        assertThat(call("POST", "/api/auth/login", Map.of("name", "旅行者", "password", "wrong"), null, null).status()).isEqualTo(401);
        Response login = call("POST", "/api/auth/login", Map.of("name", "旅行者", "password", "test-password"), null, null);
        assertThat(login.status()).isEqualTo(200);
        assertThat(call("POST", "/api/auth/logout", null, token(login), null).status()).isEqualTo(200);
        assertThat(call("GET", "/api/account", null, token(login), null).status()).isEqualTo(401);
    }

    @Test
    void expiredAndMissingTokensAreRejected() throws Exception {
        Response registration = signup("expires");
        jdbc.update("UPDATE account_sessions SET expires_at=0");
        assertThat(call("GET", "/api/account", null, token(registration), null).status()).isEqualTo(401);
        assertThat(call("GET", "/api/account", null, null, null).status()).isEqualTo(401);
    }

    @Test
    @SuppressWarnings("unchecked")
    void profileSettingsAndStarsPersistAndStarsCannotRegress() throws Exception {
        String token = token(signup("profile"));
        assertThat(call("PATCH", "/api/account/profile", Map.of("nickname", "雷电", "avatar", "hero:raiden"), token, null).status()).isEqualTo(200);
        call("PUT", "/api/account/settings", Map.of("bgmEnabled", false), token, null);
        call("PUT", "/api/account/settings", Map.of("bgmVolume", 30), token, null);
        call("PUT", "/api/account/pve-stars", Map.of("stars", Map.of("1", 3, "2", 1)), token, null);
        call("PUT", "/api/account/pve-stars", Map.of("stars", Map.of("1", 1, "3", 2)), token, null);
        Map<String, Object> profile = account(call("GET", "/api/account", null, token, null));
        assertThat(profile).containsEntry("nickname", "雷电").containsEntry("avatar", "hero:raiden");
        assertThat((Map<String, Object>) profile.get("settings")).containsEntry("bgmEnabled", false).containsEntry("bgmVolume", 30);
        assertThat((Map<String, Object>) profile.get("pveStars")).containsEntry("1", 3).containsEntry("2", 1).containsEntry("3", 2);
        assertThat(jdbc.queryForObject("SELECT nickname FROM accounts", String.class)).isEqualTo("雷电");
    }

    @Test
    void invalidRequestsCannotMutateState() throws Exception {
        String token = token(signup("validate"));
        assertThat(call("PATCH", "/api/account/profile", Map.of("nickname", "   "), token, null).status()).isEqualTo(400);
        assertThat(call("PUT", "/api/account/pve-stars", Map.of("stars", Map.of("1", 4)), token, null).status()).isEqualTo(400);
        assertThat(call("PUT", "/api/account/pve-stars", Map.of("stars", Map.of("1", 1.5)), token, null).status()).isEqualTo(400);
        assertThat(call("PUT", "/api/account/settings", Map.of("__proto__", "invalid"), token, null).status()).isEqualTo(400);
        assertThat(call("POST", "/api/auth/signup", Map.of("name", "incomplete"), null, null).status()).isEqualTo(400);
        assertThat(call("POST", "/api/auth/login", Map.of("name", "validate", "password", "密".repeat(25)), null, null).status()).isEqualTo(400);
        assertThat(call("POST", "/api/auth/signup", Map.of("name", "long-password", "password", "密".repeat(25)), null, null).status()).isEqualTo(400);
        assertThat(account(call("GET", "/api/account", null, token, null))).containsEntry("nickname", "validate");
    }

    @Test
    @SuppressWarnings("unchecked")
    void internalSettlementRequiresKeyAndIsAtomicAndIdempotent() throws Exception {
        Response registration = signup("settle");
        String id = (String) account(registration).get("id");
        String path = "/internal/accounts/" + id + "/pvp-result";
        Map<String, Object> result = Map.of("amount", 150, "operationId", "game:one", "role", "Rebel", "won", true);
        assertThat(call("POST", path, result, token(registration), null).status()).isEqualTo(403);
        assertThat(call("POST", path, result, null, "wrong").status()).isEqualTo(403);
        Response first = call("POST", path, result, null, INTERNAL_KEY);
        assertThat(first.status()).isEqualTo(200);
        assertThat(first.body()).containsEntry("oldLevel", 1).containsEntry("newLevel", 2).containsEntry("totalExp", 150).containsEntry("leveledUp", true);
        assertThat(call("POST", path, result, null, INTERNAL_KEY).body()).isEqualTo(first.body());
        Map<String, Object> profile = account(call("GET", "/api/account", null, token(registration), null));
        assertThat(profile).containsEntry("exp", 150);
        assertThat((Map<String, Object>) profile.get("stats")).containsEntry("totalGames", 1).containsEntry("totalWins", 1);
        assertThat(call("POST", path, Map.of("amount", 250, "operationId", "game:one", "role", "Rebel", "won", true), null, INTERNAL_KEY).status()).isEqualTo(409);
        assertThat(call("POST", path, Map.of("amount", 20, "operationId", "bad-role", "role", "Unknown", "won", true), null, INTERNAL_KEY).status()).isEqualTo(400);
    }

    @Test
    @SuppressWarnings("unchecked")
    void concurrentDuplicateSettlementsCountOnlyOnce() throws Exception {
        Response registration = signup("concurrent");
        String id = (String) account(registration).get("id");
        String path = "/internal/accounts/" + id + "/pvp-result";
        Map<String, Object> result = Map.of("amount", 100, "operationId", "game:concurrent", "role", "Monarch", "won", false);
        try (var pool = Executors.newFixedThreadPool(6)) {
            List<java.util.concurrent.Callable<Response>> requests = new ArrayList<>();
            for (int i = 0; i < 6; i++) requests.add(() -> call("POST", path, result, null, INTERNAL_KEY));
            for (var future : pool.invokeAll(requests)) assertThat(future.get().status()).isEqualTo(200);
        }
        Map<String, Object> profile = account(call("GET", "/api/account", null, token(registration), null));
        assertThat(profile).containsEntry("exp", 100);
        assertThat((Map<String, Object>) profile.get("stats")).containsEntry("totalGames", 1).containsEntry("totalWins", 0);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM account_operations", Integer.class)).isEqualTo(1);
    }

    @Test
    void levelSixtyCapsAndRejectsFractionalOrNegativeExperience() throws Exception {
        Response registration = signup("cap");
        String id = (String) account(registration).get("id");
        jdbc.update("UPDATE accounts SET exp=? WHERE id=?", LevelProgress.MAX_EXP - 10, id);
        String path = "/internal/accounts/" + id + "/exp";
        Response settled = call("POST", path, Map.of("amount", 100, "operationId", "cap:one"), null, INTERNAL_KEY);
        assertThat(settled.body()).containsEntry("newLevel", 60).containsEntry("totalExp", (int) LevelProgress.MAX_EXP);
        assertThat(call("POST", path, Map.of("amount", -1, "operationId", "bad"), null, INTERNAL_KEY).status()).isEqualTo(400);
        assertThat(call("POST", path, Map.of("amount", 1.5, "operationId", "bad"), null, INTERNAL_KEY).status()).isEqualTo(400);
    }

    @Test
    void legacyImportIsRepeatableAndSuccessfulLoginUpgradesHash() throws Exception {
        Map<String, Object> legacy = Map.of("id", "legacy-account", "name", "old-user", "passwordHash", AccountService.sha256("old-password"),
                "nickname", "旧玩家", "exp", 150, "pveStars", Map.of("1", 3));
        transactions.executeWithoutResult(status -> assertThat(importer.importRows(List.of(legacy))).isEqualTo(1));
        transactions.executeWithoutResult(status -> assertThat(importer.importRows(List.of(legacy))).isZero());
        Response login = call("POST", "/api/auth/login", Map.of("name", "old-user", "password", "old-password"), null, null);
        assertThat(login.status()).isEqualTo(200);
        assertThat(account(login)).containsEntry("id", "legacy-account").containsEntry("level", 2).containsEntry("exp", 150);
        assertThat(jdbc.queryForObject("SELECT password_hash FROM accounts", String.class)).startsWith("$2a$");
        assertThat(call("POST", "/api/auth/login", Map.of("name", "old-user", "password", "old-password"), null, null).status()).isEqualTo(200);
    }

    @Test
    void legacyLongPasswordUsesTaggedBcryptAndStillWorksAfterUpgrade() throws Exception {
        String password = "旧密码".repeat(30);
        Map<String, Object> legacy = Map.of("id", "legacy-long", "name", "old-long", "passwordHash", AccountService.sha256(password));
        transactions.executeWithoutResult(status -> importer.importRows(List.of(legacy)));
        assertThat(call("POST", "/api/auth/login", Map.of("name", "old-long", "password", password), null, null).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT password_hash FROM accounts", String.class)).startsWith("{bcrypt-sha256}$2a$");
        assertThat(call("POST", "/api/auth/login", Map.of("name", "old-long", "password", password), null, null).status()).isEqualTo(200);
        assertThat(call("POST", "/api/auth/login", Map.of("name", "old-long", "password", password + "wrong"), null, null).status()).isEqualTo(401);
    }
}
