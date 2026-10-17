# Cambios

## 0.2.0 · 2026-10-17

- Nueva opción `otlpEndpoint`. Al terminar cada encargo, el mod envía por OTLP sus métricas (`relevo.runs`, `relevo.run.duration`, `relevo.tokens`, `relevo.claude_equivalent`, `relevo.quota_hits`) y un evento.
- Los límites de 5 horas y semanal del plan de Claude se envían al arrancar y cada minuto, con su hora de reinicio.
- Se añade `examples/monitoring`: la configuración del collector y de Claude Code y Codex, y un panel de Grafana.

## 0.1.1 · 2026-10-17

- Una respuesta vacía de agy (por ejemplo, porque le denegaron un comando de shell) ahora cuenta como fallo, y el informe dice qué se denegó.
- Las reglas del encargo piden al agente usar sus propias herramientas de lectura y edición antes que la shell.

## 0.1.0 · 2026-10-17

- Primera versión: herramientas `delegar` y `seguir`, tabla de modelos por tipo y nivel, relevo automático por cuota, línea de estado con los límites del plan, y comandos `/relevo` y `/relevo-ahorro`.
