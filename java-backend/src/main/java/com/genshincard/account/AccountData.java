package com.genshincard.account;

import java.util.Map;

record AccountData(String id, String name, String passwordHash, String nickname, String avatar,
                   long exp, long createdAt, Map<String, Integer> pveStars,
                   Map<String, Object> settings, Map<String, Object> stats) {
    AccountData withProfile(String newNickname, String newAvatar) {
        return new AccountData(id, name, passwordHash, newNickname, newAvatar, exp, createdAt, pveStars, settings, stats);
    }

    AccountData withPassword(String hash) {
        return new AccountData(id, name, hash, nickname, avatar, exp, createdAt, pveStars, settings, stats);
    }

    AccountData withExp(long newExp) {
        return new AccountData(id, name, passwordHash, nickname, avatar, newExp, createdAt, pveStars, settings, stats);
    }
}
