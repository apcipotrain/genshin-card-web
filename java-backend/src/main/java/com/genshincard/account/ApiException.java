package com.genshincard.account;

final class ApiException extends RuntimeException {
    final int status;

    ApiException(int status, String reason) {
        super(reason);
        this.status = status;
    }
}
