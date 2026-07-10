```markdown
# EduPulse Live Learning Hub – REST & Event API Guide

**Version:** `1.0.0`  
**Status:** Stable • Actively maintained  
**Base URL (prod):** `https://api.edupulse.io`  
**Base URL (sandbox):** `https://sandbox-api.edupulse.io`  

EduPulse exposes both a synchronous **REST layer** (for CRUD-style interactions) and an asynchronous **Event layer** backed by Apache Kafka (for domain events you can subscribe to).  
This document serves as a single-source reference for product managers, backend engineers, mobile/SPA teams, and partner integrators.

---

## Table of Contents
1. Authentication
2. Media Types & Conventions
3. Error Model
4. Rate Limiting & Pagination
5. REST Resources
   1. Auth
   2. Users
   3. Pulses
   4. Assignments
   5. Payments
   6. Notifications
6. Event Streams
7. Java Integration Examples
8. Change Log

---

## 1. Authentication

EduPulse uses **JSON Web Tokens (JWT)** issued via `/auth/login`.  
Include the token in the `Authorization` header for every request:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```

Tokens expire after **60 minutes**. Refresh tokens at `/auth/refresh`.

| HTTP Code | Meaning                |
|-----------|------------------------|
| 401       | Missing / invalid JWT |
| 403       | Resource-specific denial |

---

## 2. Media Types & Conventions

Header                    | Example                              | Mandatory
---------------------------|--------------------------------------|-----------
`Content-Type`             | `application/json`                   | Yes (POST/PUT)
`Accept`                   | `application/vnd.edupulse.v1+json`   | Yes

Dates use ISO-8601 (`2024-11-15T14:30:00Z`).  
Monetary fields are expressed in **minor units** (cents).

---

## 3. Error Model

```json
{
  "timestamp": "2024-11-15T14:30:00Z",
  "status": 422,
  "error": "VALIDATION_FAILED",
  "message": "title must not be blank",
  "path": "/api/v1/pulses"
}
```

Top-level `error` codes: `AUTH_FAILED`, `VALIDATION_FAILED`, `NOT_FOUND`, `RATE_LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

---

## 4. Rate Limiting & Pagination

• **150** requests per minute per token (429 returned when exceeded).  
• Standard `Link` header pagination:

```
Link: <https://api.edupulse.io/api/v1/pulses?page=3&size=20>; rel="next"
```

Query params: `page` (0-based), `size` (max = 50), `sort` (`field,asc|desc`).

---

## 5. REST Resources

### 5.1 Auth

#### POST `/api/v1/auth/login`

| Field       | Type   | Notes                  |
|-------------|--------|------------------------|
| `email`     | String | **Required**           |
| `password`  | String | **Required** (min 8)   |

Success → `200 OK` with body:

```json
{
  "accessToken":  "eyJhbGci...fQ",
  "refreshToken": "eyJhbGci...fQ",
  "expiresIn":    3600
}
```

---

### 5.2 Users

| Method | Endpoint                    | Description                   |
|--------|-----------------------------|-------------------------------|
| GET    | `/api/v1/users`            | List (supports filters)       |
| POST   | `/api/v1/users`            | Register new user             |
| GET    | `/api/v1/users/{id}`       | Fetch profile                 |
| PUT    | `/api/v1/users/{id}`       | Update profile (self only)    |
| DELETE | `/api/v1/users/{id}`       | Soft-delete (admin only)      |

Partial `User` schema:

```jsonc
{
  "id": "df2a78b9-5d96-4c9a-9aa2-4e12ad2ff67c",
  "displayName": "Ada Lovelace",
  "roles": ["STUDENT"],
  "avatarUrl": "https://cdn.edupulse.io/avatars/ada.png",
  "createdAt": "2024-05-02T12:00:05Z"
}
```

---

### 5.3 Pulses

| Method | Endpoint                         | Description              |
|--------|----------------------------------|--------------------------|
| GET    | `/api/v1/pulses`                 | Global feed (paginated)  |
| POST   | `/api/v1/pulses`                 | Create pulse             |
| GET    | `/api/v1/pulses/{id}`            | Pulse details            |
| PUT    | `/api/v1/pulses/{id}`            | Edit (author only)       |
| DELETE | `/api/v1/pulses/{id}`            | Remove (author/admin)    |
| POST   | `/api/v1/pulses/{id}/like`       | Toggle like              |
| GET    | `/api/v1/pulses/{id}/comments`   | Comments list            |
| POST   | `/api/v1/pulses/{id}/comments`   | Add comment              |

`Pulse` schema (abridged):

```jsonc
{
  "id":"f934a0e2-3a7d-4589-8d60-d3f1caea987c",
  "author": { "id": "...", "displayName": "Ada Lovelace" },
  "content": {
      "text": "Binary is the basis of computing.",
      "media": [
        { "type": "IMAGE", "url": "https://cdn.edupulse.io/pulses/42/img1.png" }
      ]
  },
  "stats": {
      "likes": 3,
      "comments": 1
  },
  "createdAt":"2024-11-15T14:30:00Z"
}
```

Validation rules:  
• `content.text` ≤ 500 characters  
• Up to **3** media attachments per pulse  
• Only `IMAGE`, `VIDEO`, `FILE` MIME types whitelisted  

---

### 5.4 Assignments

| Method | Endpoint                               | Description                    |
|--------|----------------------------------------|--------------------------------|
| POST   | `/api/v1/assignments`                 | Instructor creates assignment |
| GET    | `/api/v1/assignments/{id}`            | Retrieve assignment details   |
| POST   | `/api/v1/assignments/{id}/submissions`| Student submission            |

Upload uses **multipart/form-data** with field `file`.

---

### 5.5 Payments

| Method | Endpoint          | Description                        |
|--------|-------------------|------------------------------------|
| POST   | `/api/v1/payments`| Initiate Stripe checkout session   |

Request body:

```jsonc
{
  "bundleId": "premium-algorithms-2024",
  "paymentMethod": "CARD",
  "successUrl": "https://edupulse.io/payments/success",
  "cancelUrl": "https://edupulse.io/payments/cancel"
}
```

Responses:  
• `201 Created` → returns `checkoutUrl` (redirect user)  
• `402 Payment Required` on rejection

---

### 5.6 Notifications

| Method | Endpoint               | Description                |
|--------|------------------------|----------------------------|
| GET    | `/api/v1/notifications`| Unread notifications feed  |
| PATCH  | `/api/v1/notifications/{id}` | Mark as read          |

---

## 6. Event Streams (Kafka)

Topic                 | Payload (value)           | Key                |
-----------------------|---------------------------|--------------------|
`pulses.created`       | `PulseCreatedEvent`       | `pulseId`          |
`pulses.liked`         | `PulseLikedEvent`         | `pulseId`          |
`assignments.submitted`| `AssignmentSubmittedEvent`| `assignmentId`     |
`payments.completed`   | `PaymentCompletedEvent`   | `paymentId`        |
`users.registered`     | `UserRegisteredEvent`     | `userId`           |

Example payload for `PulseCreatedEvent`:

```jsonc
{
  "pulseId":   "f934a0e2-3a7d-4589-8d60-d3f1caea987c",
  "authorId":  "df2a78b9-5d96-4c9a-9aa2-4e12ad2ff67c",
  "createdAt": "2024-11-15T14:30:00Z"
}
```

Schema registry URL: `https://kafka.edupulse.io/schema-registry`

---

## 7. Java Integration Examples

### 7.1 Consuming the REST API (Spring WebClient)

```java
WebClient client = WebClient.builder()
        .baseUrl("https://api.edupulse.io/api/v1")
        .defaultHeader(HttpHeaders.ACCEPT, "application/vnd.edupulse.v1+json")
        .build();

Mono<String> tokenMono = client.post()
        .uri("/auth/login")
        .contentType(MediaType.APPLICATION_JSON)
        .bodyValue(Map.of("email", "ada@edupulse.io", "password", "P@ssw0rd!"))
        .retrieve()
        .bodyToMono(JsonNode.class)
        .map(node -> node.get("accessToken").asText());

Flux<PulseDto> feed = tokenMono.flatMapMany(token ->
        client.get()
              .uri("/pulses?page=0&size=20")
              .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
              .retrieve()
              .bodyToFlux(PulseDto.class)
);
```

`PulseDto` can be generated via [jsonschema2pojo](https://www.jsonschema2pojo.org/) from the `Pulse` schema above.

### 7.2 Subscribing to Kafka Events (Spring Boot)

```java
@EnableKafka
@Configuration
public class KafkaConfig {

    @Bean
    public ConsumerFactory<String, PulseCreatedEvent> consumerFactory() {
        Map<String, Object> props = Map.of(
            ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka.edupulse.io:9092",
            ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class,
            ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, JsonDeserializer.class,
            JsonDeserializer.TRUSTED_PACKAGES, "io.edupulse.events"
        );
        return new DefaultKafkaConsumerFactory<>(props,
                new StringDeserializer(),
                new JsonDeserializer<>(PulseCreatedEvent.class));
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, PulseCreatedEvent> kafkaListenerContainerFactory(
            ConsumerFactory<String, PulseCreatedEvent> consumerFactory) {

        ConcurrentKafkaListenerContainerFactory<String, PulseCreatedEvent> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(consumerFactory);
        factory.setCommonErrorHandler(new DefaultErrorHandler(
                new ExponentialBackOff(1000L, 2.0), // retry with backoff
                List.of(new IllegalArgumentException())
        ));
        return factory;
    }
}

@Slf4j
@Component
public class PulseCreatedListener {

    @KafkaListener(topics = "pulses.created", groupId = "analytics-service")
    public void handle(PulseCreatedEvent event) {
        log.info("New pulse {} by author {}", event.getPulseId(), event.getAuthorId());
        // downstream processing...
    }
}
```

---

## 8. Change Log

Date         | Version | Notes
-------------|---------|------------------------------
2024-11-15   | 1.0.0   | Initial public release
```
