package com.genshincard.account;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/** One-way import: existing database rows always win; legacy JSON remains untouched. */
@Component
class LegacyAccountImporter implements ApplicationRunner {
    private static final Logger log = LoggerFactory.getLogger(LegacyAccountImporter.class);
    private final AccountRepository repository;
    private final JsonMapper json;
    private final TransactionTemplate transactions;
    private final String filename;

    LegacyAccountImporter(AccountRepository repository, JsonMapper json, TransactionTemplate transactions,
                          @Value("${app.legacy-accounts}") String filename) {
        this.repository = repository;
        this.json = json;
        this.transactions = transactions;
        this.filename = filename;
    }

    @Override
    public void run(ApplicationArguments ignored) throws Exception {
        if (filename.isBlank()) return;
        Path file = Path.of(filename).toAbsolutePath().normalize();
        if (!Files.exists(file)) return;
        List<Map<String, Object>> rows = json.readValue(Files.readString(file), new TypeReference<List<Map<String, Object>>>() {});
        Integer imported = transactions.execute(status -> importRows(rows));
        log.info("旧账号导入完成：新增 {} 条；源文件保留", imported);
    }

    int importRows(List<Map<String, Object>> rows) {
        int imported = 0;
        for (Map<String, Object> row : rows) {
            String id = requiredString(row, "id");
            String name = AccountService.normalizedName(requiredString(row, "name"));
            if (repository.findById(id, false) != null || repository.findByName(name, false) != null) continue;
            String hash = requiredString(row, "passwordHash");
            if (id.length() > 64 || !hash.matches("[a-fA-F0-9]{64}|(?:\\{bcrypt-sha256\\})?\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}"))
                throw new IllegalStateException("旧账号文件的ID或密码哈希格式无效；已中止导入");
            String nickname = row.get("nickname") instanceof String value && !value.isBlank() ? value : name;
            String avatar = row.get("avatar") instanceof String value ? value : "";
            if (nickname.length() > 12 || avatar.length() > 262144) throw new IllegalStateException("旧账号资料超长；已中止导入");
            Map<String, Integer> stars = new LinkedHashMap<>();
            if (row.get("pveStars") instanceof Map<?, ?> source) {
                source.forEach((key, value) -> {
                    if (key instanceof String level && level.matches("[1-9][0-9]{0,5}") && value instanceof Number n && n.intValue() >= 0 && n.intValue() <= 3)
                        stars.put(level, n.intValue());
                });
            }
            Map<String, Object> settings = objectMap(row.get("settings"));
            Map<String, Object> stats = AccountService.emptyStats();
            Map<String, Object> oldStats = objectMap(row.get("stats"));
            stats.put("totalGames", nonnegative(oldStats.get("totalGames"), 0));
            stats.put("totalWins", nonnegative(oldStats.get("totalWins"), 0));
            for (String role : List.of("monarch", "minister", "rebel", "traitor")) {
                Map<String, Object> source = objectMap(oldStats.get(role));
                Map<String, Object> roleStats = new LinkedHashMap<>();
                roleStats.put("games", nonnegative(source.get("games"), 0));
                roleStats.put("wins", nonnegative(source.get("wins"), 0));
                stats.put(role, roleStats);
            }
            repository.insert(new AccountData(id, name, hash, nickname, avatar,
                    Math.min(LevelProgress.MAX_EXP, nonnegative(row.get("exp"), 0)),
                    nonnegative(row.get("createdAt"), System.currentTimeMillis()), stars, settings, stats));
            imported++;
        }
        return imported;
    }

    private static String requiredString(Map<String, Object> row, String key) {
        if (row.get(key) instanceof String value && !value.isBlank()) return value;
        throw new IllegalStateException("旧账号文件缺少必填字段：" + key + "；已中止导入");
    }

    private static long nonnegative(Object value, long fallback) {
        return value instanceof Number n ? Math.max(0, n.longValue()) : fallback;
    }

    private static Map<String, Object> objectMap(Object source) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (source instanceof Map<?, ?> map) map.forEach((k, v) -> { if (k instanceof String key) result.put(key, v); });
        return result;
    }
}
