package com.genshincard.account;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

@RestControllerAdvice
class ApiErrorHandler {
    private static final Logger log = LoggerFactory.getLogger(ApiErrorHandler.class);

    @ExceptionHandler(ApiException.class)
    ResponseEntity<Map<String, Object>> domain(ApiException error) {
        return ResponseEntity.status(error.status).body(Map.of("success", false, "reason", error.getMessage()));
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class})
    ResponseEntity<Map<String, Object>> invalid(Exception ignored) {
        return ResponseEntity.badRequest().body(Map.of("success", false, "reason", "请求参数格式错误"));
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<Map<String, Object>> unexpected(Exception error) {
        log.error("账号服务处理请求失败", error);
        return ResponseEntity.internalServerError().body(Map.of("success", false, "reason", "账号服务暂时不可用"));
    }
}
