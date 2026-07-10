```markdown
# `@streampulse-nexus/service-transcoder`

High-performance, carrier-grade media transcoding micro-service for the **StreamPulse Nexus** interactive streaming platform.  
`service-transcoder` ingests a single mezzanine stream (video, audio, subtitles, timed-metadata) and produces adaptive-bitrate renditions (HLS/DASH) in *near real-time* while exposing health, metrics and dynamic re-configuration endpoints.

![Service Diagram](./docs/assets/transcoder.svg)

---

## ✨  Feature highlights
- **Pluggable codec pipeline** – register new GPU or software encoders at runtime.
- **Dynamic ABR ladder** – auto-generated ladder based on bandwidth + device telemetry.
- **Live waveform & loudness analysis** – feeds StreamPulse overlay widgets.
- **Frame-accurate clipping** – leveraged by instant-replay + highlights service.
- **Zero-trust control plane** – mTLS, signed JWT request validation, rate-limiting.
- **Self-healing & A/B failover** – leverages Nexus command bus for cluster orchestration.
- **First-class observability** – Prometheus metrics, OpenTelemetry traces, structured logs.

---

## ⚙️  Architecture

```
┌───────────────────────────────┐
│           ingress             │  Mezzanine (SRT / RTMP / RIST)
└───────▲────────────────────▲──┘
        │control plane       │media packets
┌───────┴──────────┐   ┌─────┴────────────┐
│  REST / gRPC API │   │  Packet Router   │
└───────▲──────────┘   └─────▲────────────┘
        │                    │
        │       ┌────────────┴──────────┐
        │       │  Transcode Workers    │  (GPU pool)
        │       └────────────┬──────────┘
        │                    │
        │              ┌─────▼────────────┐
        │              │   Segmenter      │
        │              └─────▲────────────┘
        │                    │
┌───────┴───────────┐  ┌─────┴────────────┐
│  Health & Metrics │  │   Storage/Cache  │
└───────────────────┘  └──────────────────┘
```

Workers are isolated Node.js processes communicating with the master via a lightweight message bus (`NATS`).  
GPU workers are spawned on demand and pinned to specific NVENC/AMF/QuickSync devices to guarantee consistent throughput.

---

## 🚀  Quick start

> Prerequisites  
> - Node.js 18+  
> - Local NVidia driver / FFmpeg >= 5  
> - `nats-server` running on `localhost:4222`

```bash
git clone https://github.com/streampulse-nexus/streampulse-nexus.git
cd streampulse-nexus/packages/service-transcoder
pnpm i  # or npm/yarn
cp .env.example .env     # adjust environment variables
pnpm dev                 # runs in watch mode with ts-node
```

Open http://localhost:7100/docs for the Swagger UI.

---

## 🛠️  Usage examples

### 1. Create a new transcode session (REST)

```bash
curl -X POST http://localhost:7100/v1/sessions \
     -H "Authorization: Bearer $TOKEN"          \
     -H "Content-Type: application/json"        \
     -d '{
           "input": "srt://public.ingest:1290?streamid=abc123",
           "profile": "hd-plus"
         }'
```

Response:

```json
{
  "id": "sess_b3b9d8e1",
  "status": "starting",
  "hlsUrl": "https://edge-01.nexus/cdn/sess_b3b9d8e1/master.m3u8"
}
```

### 2. Update an ABR ladder on-the-fly (gRPC)

```ts
import { LadderServiceClient } from '@streampulse-nexus/proto';

const client = new LadderServiceClient('localhost:7102', grpc.credentials.createInsecure());

await client.updateLadder({
  sessionId: 'sess_b3b9d8e1',
  ladder: [
    { name: '2160p', bitrate: 12000, width: 3840, height: 2160, fps: 60 },
    { name: '1080p', bitrate: 8000,  width: 1920, height: 1080, fps: 60 },
    { name: '720p',  bitrate: 5000,  width: 1280, height: 720,  fps: 60 }
  ]
});
```

### 3. Listen to real-time events (EventBridge)

```ts
import { createEventStream } from '@streampulse-nexus/sdk';

const stream = await createEventStream('*', { endpoint: 'wss://nexus-events' });

stream.on('session.bufferUnderrun', (payload) => {
  console.warn('Playback at risk!', payload);
});
```

---

## 📚  Public API Summary

| Method | Path / RPC          | Description                           |
|--------|---------------------|---------------------------------------|
| GET    | `/v1/health/live`   | Liveness probe for orchestrators      |
| GET    | `/v1/health/ready`  | Readiness probe incl. GPU pool status |
| POST   | `/v1/sessions`      | Spin up a new transcoding session     |
| GET    | `/v1/sessions/:id`  | Retrieve session details + metrics    |
| POST   | `/v1/reload`        | Hot-reload FFmpeg filters/codecs      |
| gRPC   | `LadderService`     | CRUD on ABR ladders                   |
| gRPC   | `ClipService`       | Frame-accurate server-side clipping   |

Full OpenAPI + protobuf definitions live under [`/docs`](./docs).

---

## 🧩  Environment Variables

| Variable                       | Default             | Description                                             |
|--------------------------------|---------------------|---------------------------------------------------------|
| `TRANSCODER_PORT`              | `7100`              | HTTP ingress                                            |
| `TRANSCODER_GRPC_PORT`         | `7102`              | gRPC ingress                                            |
| `NATS_URL`                     | `nats://localhost`  | Internal message bus                                    |
| `JWT_PUBLIC_KEY`               | ‑                   | PEM-encoded, used for API auth                          |
| `GPU_CONCURRENCY_LIMIT`        | `3`                 | max sessions per GPU card                               |
| `ABR_MAX_LADDER_HEIGHT`        | `2160`              | auto-ladder upper bound                                 |
| `REDIS_URL`                    | `redis://localhost` | cache for segment manifests                             |
| `PROMETHEUS_PUSHGATEWAY_URL`   | -                   | optional push endpoint for on-prem deployments          |

---

## 🧑‍💻  Developing

We ❤️ contributors! Sane defaults are in `.vscode/settings.json`.

```bash
pnpm test              # jest powered unit tests
pnpm lint:fix          # eslint + prettier
pnpm typecheck         # tsc --noEmit
pnpm bench             # benchmarks (worker_threads)
```

### Debugging GPU workers

```bash
NODE_OPTIONS="--inspect=0.0.0.0:9230" \
GPU_WORKER_DEBUG=1                     \
pnpm dev
```

Attach your Chromium DevTools to `localhost:9230` for live debugging.

---

## ♻️  Contributing Codec Plugins

Transcoder exposes a simple plugin interface:

```ts
// ./plugins/av1/Av1Encoder.ts
import { EncoderPlugin, EncoderConfig } from '@streampulse-nexus/service-transcoder';

export default class Av1Encoder implements EncoderPlugin {
  name = 'av1-libsvt';
  supportedCodecs = ['av1'];

  // runs once per worker
  async init() { /* load native bindings */ }

  // invoked per session
  async spawn(config: EncoderConfig) {
    return [
      '-c:v', 'libsvtav1',
      '-preset', '4',
      '-b:v', `${config.targetBitrate}k`,
      '-pix_fmt', 'yuv420p10le'
    ];
  }
}
```

Register plugin in `transcoder.config.ts`:

```ts
import Av1Encoder from './plugins/av1/Av1Encoder';

export default /** @type {TranscoderConfig} */ ({
  plugins: [
    new Av1Encoder()
  ]
});
```

---

## 🛡️  Security

We enforce:

1. Strict input validation using [`zod`](https://github.com/colinhacks/zod).
2. JWT signature + claims verification (issuer, audience, `exp`).
3. mTLS between micro-services – certificates rotated via Nexus CA.
4. Rate limiting (`@fastify/rate-limit`).
5. Dependency scanning (Snyk + GitHub Dependabot).

Found a vulnerability? See [`SECURITY.md`](./SECURITY.md).

---

## ☁️  Deployment at scale

Official Helm charts under `/deployments/charts/transcoder`.

Supports:
- Auto-scaling GPU node-pools (GKE, EKS, AKS)
- Spot instance fallback with pre/post drain hooks
- Prometheus + Grafana dashboards (pre-baked)
- Alertmanager rules for latency/jitter anomalies

---

## 📜  License

Apache-2.0 © 2024 StreamPulse Inc.
```