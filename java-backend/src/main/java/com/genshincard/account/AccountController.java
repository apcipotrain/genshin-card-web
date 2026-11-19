package com.genshincard.account;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
class AccountController {
    record Credentials(@NotBlank String name, @NotNull String password) {}
    record ProfileUpdate(String nickname, String avatar) {}
    record StarUpdate(@NotNull Map<String, Integer> stars) {}
    record ExpUpdate(@NotNull @Min(0) @Max(100000) Integer amount, @NotBlank String operationId) {}
    record PvpResult(@NotNull @Min(0) @Max(100000) Integer amount, @NotBlank String operationId,
                     @NotBlank String role, @NotNull Boolean won) {}

    private final AccountService service;
    private volatile boolean ready;

    AccountController(AccountService service) {
        this.service = service;
    }

    @EventListener(ApplicationReadyEvent.class)
    void ready() { ready = true; }

    @GetMapping("/api/health")
    ResponseEntity<Map<String, Object>> health() {
        return ResponseEntity.status(ready ? 200 : 503).body(Map.of("status", ready ? "ok" : "starting", "service", "java-account"));
    }

    @PostMapping("/api/auth/signup")
    Map<String, Object> signup(@Valid @RequestBody Credentials data) { return service.signup(data.name(), data.password()); }

    @PostMapping("/api/auth/login")
    Map<String, Object> login(@Valid @RequestBody Credentials data) { return service.login(data.name(), data.password()); }

    @GetMapping("/api/account")
    Map<String, Object> account(@RequestHeader(value="Authorization", required=false) String auth) { return service.profile(auth); }

    @PostMapping("/api/auth/logout")
    Map<String, Object> logout(@RequestHeader(value="Authorization", required=false) String auth) {
        service.logout(auth);
        return Map.of("success", true);
    }

    @PatchMapping("/api/account/profile")
    Map<String, Object> profile(@RequestHeader(value="Authorization", required=false) String auth, @RequestBody ProfileUpdate data) {
        return service.updateProfile(auth, data.nickname(), data.avatar());
    }

    @PutMapping("/api/account/settings")
    Map<String, Object> settings(@RequestHeader(value="Authorization", required=false) String auth, @RequestBody Map<String, Object> data) {
        service.saveSettings(auth, data);
        return Map.of("success", true);
    }

    @PutMapping("/api/account/pve-stars")
    Map<String, Object> stars(@RequestHeader(value="Authorization", required=false) String auth, @Valid @RequestBody StarUpdate data) {
        service.saveStars(auth, data.stars());
        return Map.of("success", true);
    }

    @PostMapping("/internal/accounts/{id}/exp")
    Map<String, Object> exp(@RequestHeader(value="X-Game-Service-Key", required=false) String key, @PathVariable String id, @Valid @RequestBody ExpUpdate data) {
        service.requireGameService(key);
        return service.settle(id, data.amount(), data.operationId(), null, null);
    }

    @PostMapping("/internal/accounts/{id}/pvp-result")
    Map<String, Object> pvp(@RequestHeader(value="X-Game-Service-Key", required=false) String key, @PathVariable String id, @Valid @RequestBody PvpResult data) {
        service.requireGameService(key);
        return service.settle(id, data.amount(), data.operationId(), data.role(), data.won());
    }
}
