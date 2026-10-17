# Monitorizar Claude Code, Codex y agy

Con estos archivos, las tres herramientas mandan su telemetría al mismo Grafana. Claude Code y Codex la envían por su cuenta, por OpenTelemetry. agy no tiene telemetría propia, así que la cubre ia-relevo: al terminar cada encargo, el mod envía qué motor y qué modelo lo hicieron, cuánto tardó y cuántos tokens gastó. También envía los límites de 5 horas y semanal de tu plan de Claude, que la telemetría de Claude Code no incluye.

Necesitas un OpenTelemetry Collector (la distribución `contrib`, porque usa el procesador `deltatocumulative`), Prometheus, Loki 3 y Grafana. [`otel-collector.yaml`](otel-collector.yaml) es la configuración del collector. Recibe OTLP/HTTP en el puerto 4318, expone las métricas en el 8889 para que Prometheus las recoja y reenvía los eventos a `http://loki:3100/otlp`. Si Claude Code y Codex corren en la misma máquina que el collector, publica ese puerto solo en loopback (`127.0.0.1:4318:4318`).

En Prometheus basta con un job más:

```yaml
scrape_configs:
  - job_name: otel
    static_configs:
      - targets: ["otel-collector:8889"]
```

Loki necesita `allow_structured_metadata: true` en `limits_config` para aceptar los atributos de los eventos.

Para Claude Code, añade esto al bloque `env` de `~/.claude/settings.json`. Las sesiones que abras a partir de ese momento ya mandarán telemetría:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "cumulative"
  }
}
```

Para Codex, añade esta sección al final de `~/.codex/config.toml`:

```toml
[otel]
environment = "local"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }
metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics", protocol = "binary" } }
```

Para ia-relevo, pon `http://127.0.0.1:4318` en su opción `otlpEndpoint`, desde `/config` o en `pluginConfigs` de tu `settings.json`:

```json
{ "pluginConfigs": { "ia-relevo": { "options": { "otlpEndpoint": "http://127.0.0.1:4318" } } } }
```

Ni Claude Code ni Codex mandan el texto de tus prompts con esta configuración. ia-relevo tampoco: solo envía el nombre corto del encargo, el motor, el modelo, el tipo, el nivel y las cifras.

[`grafana-dashboard.json`](grafana-dashboard.json) es el panel listo para importar. Espera dos fuentes de datos con uid `prometheus` y `loki`. Muestra los límites del plan con la previsión del semanal al ritmo actual, los tokens de cada herramienta, el trabajo que han hecho Codex y agy medido en tokens equivalentes de Claude, los encargos, el éxito y la duración por modelo, los relevos por falta de cuota y los errores de la API de Claude.

Estas son las métricas del mod tal como aparecen en Prometheus, y sirven también para crear tus propias alertas:

| Métrica | Etiquetas | Qué es |
|---|---|---|
| `relevo_runs_total` | `engine`, `model`, `kind`, `level`, `status`, `relayed` | encargos terminados |
| `relevo_run_duration_seconds_total` | `engine`, `model`, `kind`, `level` | segundos de trabajo |
| `relevo_tokens_total` | lo mismo y `type` (`fresh`, `cached`, `output`) | tokens del motor |
| `relevo_claude_equivalent_total` | `engine`, `model`, `kind`, `level` | tokens equivalentes de Claude |
| `relevo_quota_hits_total` | `engine` | veces que un motor se quedó sin cuota |
| `relevo_plan_limit_percent` | `window` (`five_hour`, `seven_day`) | % usado del límite del plan |
| `relevo_plan_limit_resets_at_seconds` | `window` | cuándo se reinicia, en segundos Unix |

Por ejemplo, para saber cómo acabaría la semana si sigues al ritmo de ahora:

```promql
max(relevo_plan_limit_percent{window="seven_day"}) * 604800
  / clamp_min(604800 - (max(relevo_plan_limit_resets_at_seconds{window="seven_day"}) - time()), 3600)
```
