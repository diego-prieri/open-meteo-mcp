# Convenciones del repo para dev-factory

> Única fuente de verdad que leen los comandos y subagentes de `factory` en este repo.
> Si una sección no aplica, dice `No aplica.`

## Stack

TypeScript 5.9 (ESM, `"type": "module"`), Node.js ≥ 20. Servidor MCP con `@modelcontextprotocol/sdk` ^1.32 (`McpServer`, transporte stdio). Validación de inputs con `zod` ^4. Cliente HTTP: `fetch` nativo de Node con `AbortSignal.timeout`. Tests con `node:test` + `node:assert/strict`, ejecutados con `tsx`. Sin i18n: descripciones de tools y textos de salida en inglés (ver `package.json`, `tsconfig.json`).

## Estructura de directorios

- `src/backend.ts` → interfaz del backend, tipos de dominio, cliente HTTP real y backend fake/in-memory para tests
- `src/tools/` → definición de tools MCP por dominio (schemas zod, annotations, formateo de salida, manejo de errores)
- `src/server.ts` → `createServer(backend)`: registra tools y resources, sin transporte
- `src/index.ts` → entry point stdio; arma el backend desde variables de entorno
- `test/server.test.ts` → tests cliente ↔ servidor sobre `InMemoryTransport`, sin red
- `test/live.test.ts` → smoke test contra la API real, saltado salvo que se setee una env var
- `test/fixtures/` → respuestas reales de Open-Meteo capturadas con curl (2026-11-06)

## Patrones y nombres

El modelo a seguir es el repo hermano `../georef-mcp` (mismo template, misma forma: API pública sin key, errores upstream mapeados a `isError`, live test separado).

- Backend: interfaz `XxxBackend` + `HttpXxxBackend` + `FakeXxxBackend` en `src/backend.ts`, con `XxxError(message, status?)` para errores upstream y `DEFAULT_*_URL` exportadas — modelo: `../georef-mcp/src/backend.ts`.
- Los tipos de dominio reflejan los nombres de campos de la API real (verificados con curl), no se renombran.
- Tools: `registerXxxTools(server, backend)` en `src/tools/<dominio>.ts`; helpers `ok(text, structuredContent)` y `fail(message)`; `upstreamFailure(what, e)` que agrega una pista accionable según el status (400 → revisar parámetros, 429 → esperar) — modelo: `../georef-mcp/src/tools/georef.ts`.
- Nombres de tools en `snake_case` con verbo (`search_locations`, `get_forecast`). Cada input zod con bounds y `.describe()`.
- Annotations honestas: todas las tools de lectura con `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.
- Salida: una línea compacta de texto por resultado para el modelo; el objeto completo en `structuredContent`. Resultado vacío = resultado normal con pista de qué probar, no error.
- Tests: helper `connect(backend)` con `InMemoryTransport.createLinkedPair()` y un backend fake determinístico — modelo: `test/server.test.ts`. Live test: `../georef-mcp/test/live.test.ts`.

## Antipatrones

- Escribir a `stdout` (`console.log`): rompe el protocolo stdio. Logs solo a `stderr` (`console.error`).
- Tirar excepciones desde el handler de una tool: siempre devolver `fail(...)` con `isError: true`.
- Llamar a `fetch` desde `src/tools/`: las tools dependen solo de la interfaz del backend.
- Tests unitarios que salen a la red.
- Nombres de parámetros o variables de Open-Meteo escritos de memoria: tienen que coincidir con los fixtures o con la doc oficial.
- Dejar restos del dominio de ejemplo del template (`tickets`, `T-1`, `guide://ticket-statuses`) cuando se reemplaza.

## Capas para cortar pasos

1. Tipos de dominio e interfaz del backend (`src/backend.ts`) + backend fake
2. Backend HTTP real (`HttpXxxBackend`) con su manejo de errores
3. Tools (`src/tools/<dominio>.ts`), de a una o en grupos chicos, con sus tests
4. Resources y cableado en `src/server.ts` (instructions del servidor)
5. Entry point `src/index.ts`, scripts de `package.json`, live test y README

## Verificación

- Tests acotados: `node --import tsx --test test/server.test.ts`
- Un test puntual: `node --import tsx --test --test-name-pattern="<patrón>" test/server.test.ts`
- Lint: No aplica (el repo no tiene linter).
- Tipos: `npm run typecheck`
- Build: `npm run build`
- Cobertura de lo nuevo: No aplica (no hay herramienta de cobertura configurada).

Trampas del runner:

- `--test-name-pattern` sin matches **no falla**: da verde con 0 tests. Confirmar en la salida que `# pass` es > 0.
- `npm test` corre `test/*.test.ts`, incluido el live test, que queda `skipped` salvo con la env var: un skip no es un verde del live test.

## Ruido conocido del árbol

- `dist/` y `node_modules/` (están en `.gitignore`).

## Git y commits

- Rama base: `main`
- Branch de feature: `feature/<slug>`
- ¿El flujo puede commitear solo?: sí, localmente
- ¿Puede pushear y abrir PR?: remote `origin` = github.com/diego-prieri/open-meteo-mcp (público); pushear y abrir PR solo con OK explícito del dev
- Formato del mensaje: subject en inglés, imperativo, sin prefijo (como `Upgrade zod to v4 (security advisory)`); trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Granularidad: un commit por paso de feature.

## Documentación

- Carpeta de features: `docs/features/` (cada feature en `docs/features/<slug>/`)
- Planes de bugs: `docs/features/<área>/<branch>-plan.md`
- Doc de fixes: `docs/features/<área>/<branch>.md` — uno por branch
- Áreas: `Glob docs/features/*/`
- Estilo y plantilla de la sección de un fix:

```markdown
## Fix: <síntoma>
### Síntoma
### Causa
### Solución
### Verificación
```

## Reglas de negocio sensibles

- Términos de Open-Meteo (https://open-meteo.com/en/terms): la API gratuita es solo para uso no comercial, con límites de 600 llamadas/min, 5.000/hora y 10.000/día. Los datos son CC BY 4.0 y requieren atribución. El README y las instructions del servidor lo tienen que decir; no se promete uso comercial.
- Las unidades siempre van junto al valor en la salida (Open-Meteo devuelve `*_units`); nunca mostrar un número sin unidad.
- Las horas que devuelve Open-Meteo son locales a la `timezone` pedida (con `timezone=auto`, la del lugar) y sin offset: la salida tiene que decir de qué zona son.

## Dominios sensibles

- Uso comercial de la API (requiere plan pago y API key en otro host): no implementarlo sin pedido explícito.

## Repos relacionados

- `../mcp-server-template` — template del que sale este repo
- `../georef-mcp` — servidor MCP hermano, modelo de patrones

## E2E

No aplica.
