# ia-relevo

Un mod de Claude Code que permite a Claude repartir el trabajo de código entre Codex CLI y Antigravity (agy), de modo que esas tareas se paguen con la cuota de OpenAI o de Google y no con la de tu plan de Claude. Claude se queda con la parte de pensar y revisar, y los otros agentes escriben el código.

Claude dispone de una herramienta llamada `delegar`. Cuando la usa, indica el tipo de tarea (`back` para lógica, tests y scripts; `front` para interfaz y motion; `read` para analizar mucho código; `mech` para cambios repetitivos) y su dificultad (`facil`, `normal` o `dificil`). Con esos dos datos, la tabla de [`bin/models.conf`](bin/models.conf) decide qué motor y qué modelo hacen el encargo: un Gemini Flash barato para los cambios mecánicos, Codex con `gpt-reserve` para la lógica normal y Claude Opus a través de Antigravity, que se paga con la cuota de Google, para lo difícil. Si el motor elegido se queda sin cuota, pasa una hora en pausa y la siguiente fila de la tabla hace el mismo encargo sin que tengas que hacer nada.

Los encargos se ejecutan en segundo plano. Claude solo recibe el informe final del agente, de unas quince líneas, así que su contexto no se llena con la exploración ni con las pruebas del otro agente. Cuando un encargo termina, el mod avisa a la sesión con ese informe, y Claude revisa los cambios y hace el commit. Si hace falta una corrección, la herramienta `seguir` continúa la misma conversación con el agente.

La línea de estado muestra cuántos encargos hay en marcha y cuánto llevas gastado de los límites de 5 horas y semanal de tu plan. El comando `/relevo` lista los encargos de la sesión y si algún motor está en pausa por cuota. `/relevo-ahorro [días]` suma lo que han gastado Codex y agy y lo traduce a tokens equivalentes de Claude con los precios relativos de la API. Esa cifra es una estimación, porque el plan no mide exactamente así, pero sirve para hacerse una idea del orden de magnitud.

## Instalación

Necesitas Claude Code, `bash`, `python3` y al menos uno de los dos agentes instalado y con sesión iniciada: [Codex CLI](https://github.com/openai/codex) (`codex`) o Antigravity CLI (`agy`). Con uno solo funciona, pero entonces no hay relevo cuando ese se queda sin cuota.

En el prompt de una sesión de Claude Code en el terminal:

```
/plugin install ia-relevo --marketplace angelmq152/ia-relevo
```

Desde una shell:

```bash
claude plugin install ia-relevo --marketplace angelmq152/ia-relevo
```

En la app de escritorio, donde `/plugin` no funciona, pulsa el + junto al cuadro del prompt, luego Plugins, Add marketplace con `angelmq152/ia-relevo` y después Add plugin.

## Ajustes

Para cambiar qué modelo hace cada tarea, copia `bin/models.conf` a `~/.config/ia-relevo/models.conf` y edítalo. Las filas de cada combinación de tipo y nivel se prueban en orden. Los nombres de modelo dependen de lo que tenga tu cuenta: `agy models` y la caché de modelos de Codex te dicen cuáles hay.

Si tienes un OpenTelemetry Collector, pon su URL base OTLP/HTTP en la opción `otlpEndpoint` del mod (por ejemplo `http://127.0.0.1:4318`, desde `/config` o en `pluginConfigs` de tu `settings.json`). Al terminar cada encargo, el mod enviará `relevo.runs` (con motor, modelo, tipo, nivel, resultado y si hubo relevo), `relevo.run.duration`, `relevo.tokens`, `relevo.claude_equivalent` y `relevo.quota_hits`, y un evento por encargo. También enviará los límites de 5 horas y semanal de tu plan (`relevo.plan.limit` y `relevo.plan.limit.resets_at`), que la telemetría propia de Claude Code no trae. Junto con esa telemetría (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) y la de Codex (sección `[otel]` de `~/.codex/config.toml`), tienes las tres herramientas en el mismo Grafana. Si dejas la opción vacía, el mod no envía nada.

Hay variables de entorno para lo demás: `RELEVO_RUNS` es la carpeta donde se guarda cada ejecución (por defecto `~/.claude/relevo-runs`), `RELEVO_TIMEOUT` es el tiempo máximo por encargo en segundos (3600) y `RELEVO_COOLDOWN` es cuánto tiempo queda en pausa un motor sin cuota (3600).

Antigravity solo ejecuta los comandos de shell que permitas en su propia configuración (`permissions.allow` en `~/.gemini/antigravity-cli/settings.json`). Los que deniega aparecen al final del informe, para que sepas qué regla te falta.

El script también funciona sin Claude: `bin/relevo.sh run -n prueba -C . -k back -l normal "tu encargo"` lo ejecuta en primer plano, y `bin/relevo.sh plan -k front -l dificil` te enseña qué motor y qué modelo lo harían.

## Tests

`bash tests/relevo.test.sh` prueba el script con motores falsos: la tabla, el relevo cuando un motor se queda sin cuota y las ejecuciones en segundo plano. `claude plugin test .` prueba el cálculo del ahorro y la herramienta `delegar`. GitHub Actions ejecuta los primeros y `shellcheck` en cada push.

## Licencia

MIT
