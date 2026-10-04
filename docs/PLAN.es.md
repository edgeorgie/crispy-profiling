# Plan maestro de crispy-profiling

Plan **determinístico**: cada paso tiene un comando o acción exacta, un responsable y un criterio
de "hecho" verificable. Nada avanza a la siguiente fase sin cumplir el criterio de la anterior.

- **Responsable "Claude"**: se puede hacer desde una sesión de Claude Code sobre este repo.
- **Responsable "Edwin"**: requiere tu identidad, credenciales o una decisión tuya.

## 0. Decisiones fijadas

| Tema | Decisión | Motivo |
| --- | --- | --- |
| Producto | Profiling determinista de re-renders de React para agentes y CI | Ver [MARKETPLACES.es.md](MARKETPLACES.es.md) §1 |
| Nombre npm | `crispy-profiling` (libre en npm a 2026-10-04) | Coincide con el repo |
| Lenguaje | TypeScript 5, ESM, Node ≥ 20 | Tu stack; ecosistema MCP/skills es JS-first |
| Navegador | `playwright-core` + Chromium (sin el test runner) | Ligero, control total, mismo motor en local y CI |
| Instrumentación | `__REACT_DEVTOOLS_GLOBAL_HOOK__` + diff de fibers | Sin cambios en la app; funciona con cualquier bundler |
| Validación | `zod` v4 (+ JSON Schema generado) | Errores legibles; schema para editores y agentes |
| MCP | `@modelcontextprotocol/sdk` 1.x, transporte stdio | Estándar; compatible con todos los clientes |
| Build / test / lint | tsup · vitest · Biome | Rápidos, cero configuración extra |
| Licencia | MIT | Máxima adopción |
| Idioma | Código y README en inglés; README.es y docs de estrategia en español | Alcance global + comunidad LatAm |
| Versionado | SemVer; `npm version` sincroniza `plugin.json` y `server.json` | Una sola fuente de verdad |

## 1. Fase 1 — Fundaciones (✅ hecha en esta sesión)

| # | Entregable | Archivo(s) | Verificación |
| --- | --- | --- | --- |
| 1.1 | Hook de navegador: renders, mounts, updates, wasted, causas, props cambiadas | `src/profiler/hook.ts` | `test/e2e.test.ts` |
| 1.2 | Runner de escenarios con pasos y fases | `src/profiler/run.ts` | e2e |
| 1.3 | Informe determinista (mediana/min/max, `stable`) + presupuestos | `src/report/aggregate.ts` | e2e: dos ejecuciones ⇒ JSON idéntico byte a byte |
| 1.4 | Comparación con baseline y umbrales | `src/report/compare.ts` | `test/unit.test.ts`, e2e |
| 1.5 | CLI `init/install/run/compare/mcp` con códigos de salida 0/1/2 | `src/cli.ts` | `test/cli.test.ts` |
| 1.6 | Servidor MCP con 4 herramientas | `src/mcp/server.ts` | `test/mcp.test.ts` |
| 1.7 | Agent Skill | `skills/react-render-profiling/SKILL.md` | `test/manifests.test.ts` |
| 1.8 | Plugin + marketplace de Claude Code | `.claude-plugin/*.json` | `claude plugin validate .` ✔ |
| 1.9 | Manifiesto del MCP Registry | `server.json` | `npx tsx scripts/validate-server-json.ts` ✔ |
| 1.10 | GitHub Action compuesta | `action.yml` | Fase 3 |
| 1.11 | CI (Node 20/22/24) y release automatizado | `.github/workflows/*.yml` | Primer push |
| 1.12 | README, README.es, CONTRIBUTING, SECURITY, CoC, LICENSE, CHANGELOG, AGENTS.md | raíz | Revisión |

**Criterio de hecho:** `npm run check` en verde (27 tests), manifiestos validados. ✅

## 2. Fase 2 — Hacer público el repo y la cuenta (Edwin, ~20 min)

| # | Acción | Responsable | Cómo | Hecho cuando |
| --- | --- | --- | --- | --- |
| 2.1 | Revisar y fusionar la rama `claude/upbeat-dirac-y56zb1` a `main` | Edwin | Pedir a Claude que abra el PR, revisarlo y hacer merge | `main` contiene el código y CI está en verde |
| 2.2 | (Opcional) Renombrar el repo a `crispy-profiling` (hoy `crispy-profilling`, con doble "l") | Edwin | GitHub → Settings → Repository name. GitHub redirige el nombre viejo. Luego pedir a Claude que actualice las URLs | Las URLs del README/manifiestos coinciden con el nombre |
| 2.3 | Hacer el repo **público** si no lo es | Edwin | Settings → General → Danger zone → Change visibility | La página carga sin sesión |
| 2.4 | Activar Discussions, Issues y *Private vulnerability reporting* | Edwin | Settings → General / Security | Los enlaces de `config.yml` y `SECURITY.md` funcionan |
| 2.5 | Descripción y topics del repo | Edwin | About → `react, performance, profiling, mcp, mcp-server, agent-skills, claude-code` | Visible en la portada |
| 2.6 | Proteger `main` (PR obligatorio + CI requerida) | Edwin | Settings → Branches → Add rule | Push directo bloqueado |

## 3. Fase 3 — Primer release v0.1.0 (Edwin + automatización)

| # | Acción | Responsable | Cómo | Hecho cuando |
| --- | --- | --- | --- | --- |
| 3.1 | Crear cuenta npm con 2FA | Edwin | npmjs.com | Puedes iniciar sesión |
| 3.2 | Crear token *Granular* con permiso de publicación y guardarlo como secreto `NPM_TOKEN` | Edwin | npmjs.com → Access Tokens; GitHub → Settings → Secrets and variables → Actions | El secreto aparece en la lista |
| 3.3 | Lanzar el release | Edwin o Claude | `git checkout main && git pull && git tag v0.1.0 && git push origin v0.1.0` (la versión ya es 0.1.0) | El workflow **Release** termina en verde |
| 3.4 | Verificar npm | Claude | `npm view crispy-profiling version` → `0.1.0` | ✔ |
| 3.5 | Verificar MCP Registry | Claude | `curl "https://registry.modelcontextprotocol.io/v0/servers?search=crispy"` | Aparece `io.github.edgeorgie/crispy-profiling` |
| 3.6 | Configurar *Trusted Publishing* en npm (quita la necesidad del token) | Edwin | npmjs.com → paquete → Settings → Trusted publisher → GitHub Actions, workflow `release.yml` | Siguiente release publica sin `NPM_TOKEN` |
| 3.7 | Publicar la Action en GitHub Marketplace | Edwin | Releases → editar `v0.1.0` → "Publish this Action to the GitHub Marketplace" (acepta términos una vez) | La Action aparece en marketplace |

## 4. Fase 4 — Distribución en marketplaces (Edwin + Claude, ~1 h)

| # | Destino | Responsable | Acción exacta | Hecho cuando |
| --- | --- | --- | --- | --- |
| 4.1 | skills.sh | Edwin o Claude | `npx skills add edgeorgie/crispy-profilling` desde cualquier proyecto (la primera instalación indexa el repo) | `skills.sh/edgeorgie/crispy-profilling` existe |
| 4.2 | Directorio de Anthropic | Edwin (plan de pago de claude.ai) | `claude plugin validate . --strict`; luego [claude.ai/directory/manage](https://claude.ai/directory/manage) → Submit plugin | Estado "Published" en el portal |
| 4.3 | Glama | Edwin | Buscar el repo en glama.ai/mcp/servers; si no aparece, "Add server"; reclamar con GitHub | Ficha con insignia de calidad |
| 4.4 | mcp.so | Edwin | Formulario "Submit" con la URL del repo | Ficha visible |
| 4.5 | Smithery | Edwin | smithery.ai → Publish → desde GitHub (servidor stdio vía npm) | Ficha visible |
| 4.6 | Listas *awesome* | Claude (prepara PR) + Edwin (envía) | PRs a `awesome-mcp-servers`, listas awesome de Claude Code / skills | PRs abiertos |

## 5. Fase 5 — Roadmap de producto (Claude, iterativo)

Cada ítem = 1 PR con tests de números exactos sobre la app fixture.

| Versión | Funcionalidad | Criterio de aceptación |
| --- | --- | --- |
| 0.2 | Tests e2e contra React 17 y 18 (matriz de fixtures) | e2e en verde en 17/18/19 |
| 0.2 | Comando `crispy pr-comment` que formatea la comparación para un comentario de PR | Snapshot test del Markdown |
| 0.3 | Atribución "quién provocó el render" (componente padre que inició el commit) | e2e con causa padre exacta |
| 0.3 | Soporte de `crispy.config.ts` además de JSON | Unit test |
| 0.4 | Modo "attach" a un Chrome ya abierto (CDP) para apps con login | e2e con contexto persistente |
| 0.4 | Escenarios grabados: `crispy record` genera los pasos desde Playwright codegen | Unit test del conversor |
| 0.5 | Skill adicional en español/portugués para equipos LatAm | `manifests.test.ts` |
| 1.0 | API estable, docs site (GitHub Pages), schema del informe publicado | Sin breaking changes en 2 minors |

## 6. Fase 6 — Comunidad y crecimiento (Edwin)

| # | Acción | Cuándo | Métrica |
| --- | --- | --- | --- |
| 6.1 | Post de lanzamiento (dev.to / LinkedIn / X) con el ejemplo "20 renders → 0" del README | Tras 3.3 | Visitas al repo |
| 6.2 | Show HN / r/reactjs | Tras 4.2 | Estrellas en 7 días |
| 6.3 | Etiquetar 5 issues como `good first issue` (salen del roadmap §5) | Tras 6.1 | Primer PR externo |
| 6.4 | Probarlo en un proyecto real (p. ej. interno de tu equipo) y documentar el caso | Mes 1 | 1 caso de estudio |
| 6.5 | GitHub Sponsors | Cuando haya usuarios | — |

Objetivos a 90 días: 100 ⭐, 500 descargas semanales en npm, 50 instalaciones en skills.sh,
listado aprobado en el directorio de Anthropic.

## 7. Operación continua

- **Cada PR:** CI (lint, typecheck, tests e2e reales en Chromium, build, `npm pack`, validación de
  manifiestos).
- **Cada release:** `npm version <patch|minor|major>` → `git push --follow-tags` → el workflow
  publica npm + MCP Registry + GitHub Release y mueve el tag mayor (`v0`) de la Action.
- **Dependabot:** semanal (npm) y mensual (Actions).
- **Seguridad:** reportes privados vía GitHub Security Advisories.

## 8. Lo que necesito de ti (resumen)

1. Revisar y fusionar el PR (2.1).
2. Decidir si renombras el repo a `crispy-profiling` (2.2) — recomendado, antes del primer release.
3. Repo público + Discussions + reportes privados (2.3–2.4).
4. Cuenta npm + secreto `NPM_TOKEN` (3.1–3.2).
5. Envío al directorio de Anthropic (4.2) y a Glama / mcp.so / Smithery (4.3–4.5) — requieren tu
   sesión en esos sitios.

Todo lo demás está automatizado o lo puede hacer Claude.
