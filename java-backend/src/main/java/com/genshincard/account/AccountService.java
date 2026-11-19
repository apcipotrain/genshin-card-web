package com.genshincard.account;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.*;

@Service
class AccountService {
    private final AccountRepository repository;
    private final JsonMapper json;
    private final String gameServiceKey;
    private final Duration sessionTtl;
    private final BCryptPasswordEncoder passwords = new BCryptPasswordEncoder(12);
    private final SecureRandom random = new SecureRandom();
    private static final Set<String> ROLES = Set.of("Monarch", "Minister", "Rebel", "Traitor");
    private static final String PREHASHED_BCRYPT = "{bcrypt-sha256}";

    AccountService(AccountRepository repository, JsonMapper json,
                   @Value("${app.game-service-key}") String gameServiceKey,
                   @Value("${app.session-ttl}") Duration sessionTtl) {
        if (gameServiceKey == null || gameServiceKey.isBlank()) throw new IllegalStateException("GAME_SERVICE_KEY 必须设置；请使用项目启动脚本");
        if (sessionTtl.isZero() || sessionTtl.isNegative()) throw new IllegalStateException("ACCOUNT_SESSION_TTL 必须大于零");
        this.repository = repository;
        this.json = json;
        this.gameServiceKey = gameServiceKey;
        this.sessionTtl = sessionTtl;
    }

    @Transactional
    public Map<String, Object> signup(String name, String password) {
        String normalized = normalizedName(name);
        checkPassword(password);
        AccountData account = new AccountData(UUID.randomUUID().toString(), normalized,
                passwords.encode(password), normalized, "", 0, System.currentTimeMillis(),
                new LinkedHashMap<>(), new LinkedHashMap<>(), emptyStats());
        try {
            repository.insert(account);
        } catch (DuplicateKeyException e) {
            throw new ApiException(409, "该名称已被注册");
        }
        return loginResult(account);
    }

    @Transactional
    public Map<String, Object> login(String name, String password) {
        String normalized = normalizedName(name);
        if (password == null || password.length() < 3 || password.length() > 1024)
            throw new ApiException(400, "密码格式无效");
        AccountData account = repository.findByName(normalized, true);
        if (account == null) throw new ApiException(401, "账号或密码错误");
        boolean legacy = account.passwordHash().matches("[a-fA-F0-9]{64}");
        boolean prehashed = account.passwordHash().startsWith(PREHASHED_BCRYPT);
        if (!legacy && !prehashed) checkPassword(password);
        boolean correct = legacy
                ? MessageDigest.isEqual(sha256(password).getBytes(StandardCharsets.US_ASCII), account.passwordHash().toLowerCase(Locale.ROOT).getBytes(StandardCharsets.US_ASCII))
                : prehashed
                    ? passwords.matches(sha256(password), account.passwordHash().substring(PREHASHED_BCRYPT.length()))
                    : passwords.matches(password, account.passwordHash());
        if (!correct) throw new ApiException(401, "账号或密码错误");
        if (legacy) {
            // Upgrade only after a successful verification; the source JSON file is never modified.
            // Old Node accounts allowed passwords longer than BCrypt's 72-byte limit.
            // Give those hashes an explicit format tag so future logins use the same prehash.
            String upgraded = password.getBytes(StandardCharsets.UTF_8).length > 72
                    ? PREHASHED_BCRYPT + passwords.encode(sha256(password)) : passwords.encode(password);
            account = account.withPassword(upgraded);
            repository.update(account);
        }
        return loginResult(account);
    }

    private Map<String, Object> loginResult(AccountData account) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String token = HexFormat.of().formatHex(bytes);
        repository.createSession(sha256(token), account.id(), System.currentTimeMillis() + sessionTtl.toMillis());
        return Map.of("success", true, "account", view(account), "token", token);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> profile(String authorization) {
        return Map.of("success", true, "account", view(authenticated(authorization, false)));
    }

    @Transactional
    public void logout(String authorization) {
        String token = bearer(authorization);
        repository.revoke(sha256(token));
    }

    @Transactional
    public Map<String, Object> updateProfile(String authorization, String nickname, String avatar) {
        AccountData account = authenticated(authorization, true);
        String nextNickname = nickname == null ? account.nickname() : nickname.trim();
        if (nextNickname.isEmpty() || nextNickname.length() > 12) throw new ApiException(400, "昵称长度应为1至12个字符");
        if (avatar != null && avatar.length() > 262144) throw new ApiException(400, "头像数据过大");
        AccountData changed = account.withProfile(nextNickname, avatar == null ? account.avatar() : avatar);
        repository.update(changed);
        return Map.of("success", true, "account", view(changed));
    }

    @Transactional
    public void saveSettings(String authorization, Map<String, Object> settings) {
        if (settings == null || settings.size() > 64 || json.writeValueAsString(settings).length() > 16384)
            throw new ApiException(400, "设置数据无效或过大");
        if (settings.keySet().stream().anyMatch(k -> k.isBlank() || k.length() > 64 || k.equals("__proto__") || k.equals("constructor") || k.equals("prototype")))
            throw new ApiException(400, "设置字段无效");
        AccountData account = authenticated(authorization, true);
        account.settings().putAll(settings);
        if (account.settings().size() > 64 || json.writeValueAsString(account.settings()).length() > 16384)
            throw new ApiException(400, "设置总量过大");
        repository.update(account);
    }

    @Transactional
    public void saveStars(String authorization, Map<String, Integer> stars) {
        if (stars == null || stars.size() > 1000) throw new ApiException(400, "星级数据无效");
        for (var entry : stars.entrySet()) {
            if (!entry.getKey().matches("[1-9][0-9]{0,5}") || entry.getValue() == null || entry.getValue() < 0 || entry.getValue() > 3)
                throw new ApiException(400, "关卡星级应为0至3的整数");
        }
        AccountData account = authenticated(authorization, true);
        stars.forEach((level, value) -> account.pveStars().merge(level, value, Math::max));
        repository.update(account);
    }

    public void requireGameService(String supplied) {
        if (supplied == null || !MessageDigest.isEqual(supplied.getBytes(StandardCharsets.UTF_8), gameServiceKey.getBytes(StandardCharsets.UTF_8)))
            throw new ApiException(403, "游戏服务认证失败");
    }

    @Transactional
    public Map<String, Object> settle(String accountId, int amount, String operationId, String role, Boolean won) {
        if (operationId == null || !operationId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new ApiException(400, "结算操作编号无效");
        if (amount < 0 || amount > 100000) throw new ApiException(400, "经验值应为0至100000的整数");
        if (role != null && (!ROLES.contains(role) || won == null)) throw new ApiException(400, "对局身份或胜负无效");
        AccountData account = repository.findById(accountId, true);
        if (account == null) throw new ApiException(404, "账号不存在");
        String requestHash = sha256(amount + ":" + role + ":" + won);
        Map<String, Object> previous = repository.previousOperation(accountId, operationId, requestHash);
        if (previous != null) return previous;
        int oldLevel = LevelProgress.of(account.exp()).level();
        AccountData changed = account.withExp(Math.min(LevelProgress.MAX_EXP, account.exp() + amount));
        int newLevel = LevelProgress.of(changed.exp()).level();
        if (role != null) {
            increment(changed.stats(), "totalGames", 1);
            if (won) increment(changed.stats(), "totalWins", 1);
            @SuppressWarnings("unchecked")
            Map<String, Object> roleStats = (Map<String, Object>) changed.stats().get(role.toLowerCase(Locale.ROOT));
            increment(roleStats, "games", 1);
            if (won) increment(roleStats, "wins", 1);
        }
        repository.update(changed);
        Map<String, Object> result = Map.of("success", true, "oldLevel", oldLevel, "newLevel", newLevel,
                "totalExp", changed.exp(), "leveledUp", newLevel > oldLevel);
        repository.rememberOperation(accountId, operationId, requestHash, result);
        return result;
    }

    private static void increment(Map<String, Object> map, String key, int amount) {
        map.put(key, ((Number) map.getOrDefault(key, 0)).longValue() + amount);
    }

    private AccountData authenticated(String authorization, boolean lock) {
        String id = repository.sessionAccount(sha256(bearer(authorization)));
        if (id == null) throw new ApiException(401, "登录已失效，请重新登录");
        AccountData account = repository.findById(id, lock);
        if (account == null) throw new ApiException(401, "登录已失效，请重新登录");
        return account;
    }

    private static String bearer(String header) {
        if (header == null || !header.startsWith("Bearer ") || !header.substring(7).matches("[a-f0-9]{64}")) throw new ApiException(401, "请先登录");
        return header.substring(7);
    }

    static String normalizedName(String name) {
        if (name == null || name.trim().isEmpty() || name.trim().length() > 12) throw new ApiException(400, "名称长度应为1至12个字符");
        return name.trim();
    }

    private static void checkPassword(String password) {
        if (password == null || password.length() < 3 || password.getBytes(StandardCharsets.UTF_8).length > 72)
            throw new ApiException(400, "密码至少3位，UTF-8编码后不能超过72字节");
    }

    static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private Map<String, Object> view(AccountData account) {
        LevelProgress progress = LevelProgress.of(account.exp());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", account.id()); result.put("name", account.name());
        result.put("nickname", account.nickname()); result.put("avatar", account.avatar());
        result.put("level", progress.level()); result.put("exp", account.exp()); result.put("createdAt", account.createdAt());
        result.put("currentLevelExp", progress.currentExp()); result.put("nextLevelExp", progress.nextExp());
        result.put("pveStars", account.pveStars()); result.put("settings", account.settings()); result.put("stats", account.stats());
        return result;
    }

    static Map<String, Object> emptyStats() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("totalGames", 0); result.put("totalWins", 0);
        for (String role : List.of("monarch", "minister", "rebel", "traitor")) {
            Map<String, Object> values = new LinkedHashMap<>();
            values.put("games", 0); values.put("wins", 0);
            result.put(role, values);
        }
        return result;
    }
}
