package com.genshincard.account;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class DatabasePersistenceTest {
    @TempDir Path directory;

    @Test
    void newRepositoryConnectionReadsPersistedAccountSessionAndSettlement() {
        String url = "jdbc:h2:file:" + directory.resolve("accounts").toAbsolutePath().toString().replace('\\', '/');
        var firstSource = new DriverManagerDataSource(url, "sa", "");
        new ResourceDatabasePopulator(new ClassPathResource("schema.sql")).execute(firstSource);
        JsonMapper json = JsonMapper.builder().build();
        var first = new AccountRepository(new JdbcTemplate(firstSource), json);
        first.insert(new AccountData("persisted", "persisted", "hash", "持久化", "", 150, 1000,
                new LinkedHashMap<>(Map.of("1", 3)), new LinkedHashMap<>(), AccountService.emptyStats()));
        first.createSession("hashed-session", "persisted", System.currentTimeMillis() + 60000);
        first.rememberOperation("persisted", "game:one", "request-hash", Map.of("success", true, "totalExp", 150));

        // DriverManagerDataSource closes each JDBC connection; the next repository opens the file afresh.
        var second = new AccountRepository(new JdbcTemplate(new DriverManagerDataSource(url, "sa", "")), json);
        assertThat(second.findById("persisted", false).exp()).isEqualTo(150);
        assertThat(second.findById("persisted", false).pveStars()).containsEntry("1", 3);
        assertThat(second.sessionAccount("hashed-session")).isEqualTo("persisted");
        assertThat(second.previousOperation("persisted", "game:one", "request-hash")).containsEntry("totalExp", 150);
    }
}
