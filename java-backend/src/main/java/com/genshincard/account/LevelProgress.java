package com.genshincard.account;

record LevelProgress(int level, long currentExp, long nextExp) {
    static final long MAX_EXP = maximumExp();

    private static long cost(int level) {
        return level <= 55 ? level * 100L : level * 1000L;
    }

    private static long maximumExp() {
        long total = 0;
        for (int level = 1; level < 60; level++) total += cost(level);
        return total;
    }

    static LevelProgress of(long totalExp) {
        long remainder = Math.max(0, Math.min(totalExp, MAX_EXP));
        int level = 1;
        while (level < 60 && remainder >= cost(level)) remainder -= cost(level++);
        return new LevelProgress(level, remainder, level == 60 ? 0 : cost(level));
    }
}
