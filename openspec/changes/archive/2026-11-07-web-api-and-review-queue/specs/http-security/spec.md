# Delta for http-security

## ADDED Requirements

### Requirement: API rate limit and static content security

`/api` SHALL have its own rate limiter (`RATE_LIMIT_API_WINDOW_MS`, default 60000; `RATE_LIMIT_API_MAX`, default 120; invalid values fail fast; disabling stays forbidden in production). When the development static web is served, HTML responses SHALL carry a same-origin Content-Security-Policy, while API responses keep the existing security headers and `Cache-Control: no-store`.

#### Scenario: API limiter
- GIVEN `RATE_LIMIT_API_MAX=2`
- WHEN a third API request arrives within the window
- THEN it receives 429 with RateLimit headers
