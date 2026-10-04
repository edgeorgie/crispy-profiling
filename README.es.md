# 🥓 crispy-profiling

**Profiling determinista de renders de React para personas, CI y agentes de IA.**

[English](README.md)

crispy-profiling abre tu app de React en Chromium headless, ejecuta las interacciones que describes
y te dice **qué componentes se renderizaron, cuántas veces, por qué** (props / state / context /
padre) y **qué renders fueron desperdiciados**. Los conteos son deterministas: dos informes del
mismo escenario solo difieren si cambió el código. Eso lo convierte en un ciclo de feedback fiable
para:

- **Agentes de IA**: servidor MCP y [Agent Skill](skills/react-render-profiling/SKILL.md) para que
  Claude Code, Cursor, Codex, Copilot, etc. *midan* una optimización en lugar de adivinar.
- **CI**: presupuestos de renders y comparación con baseline que hacen fallar un PR cuando un
  componente empieza a re-renderizarse.
- **Tú**: una CLI que responde "¿por qué se re-renderiza esto?" sin abrir DevTools.

Sin cambios en tu app: usa el mismo hook que React DevTools.

## Inicio rápido

```bash
npm i -D crispy-profiling
npx crispy install                                   # descarga el Chromium compatible (una vez)
npx crispy init --base-url http://localhost:5173     # crea crispy.config.json
npm run dev &                                        # tu app, build de desarrollo
npx crispy run                                       # escribe .crispy/report.json y muestra un resumen
npx crispy compare .crispy/base.json .crispy/report.json
```

## Para agentes

```bash
claude mcp add crispy-profiling -- npx -y crispy-profiling@latest mcp   # servidor MCP
npx skills add edgeorgie/crispy-profilling                              # skill (40+ agentes)
```

Plugin de Claude Code (MCP + skill):

```text
/plugin marketplace add edgeorgie/crispy-profilling
/plugin install crispy-profiling@crispy-profiling
```

## Cómo leer los números

| Campo | Significado | Arreglo típico |
| --- | --- | --- |
| `wastedRenders` (causa `parent`) | Props, state y context idénticos | `React.memo` o bajar el state |
| `changedProps` con funciones | Callback inline recreado | `useCallback` + `React.memo` |
| `changedProps` con objetos/arrays | Literal recreado | `useMemo` o constante fuera del componente |
| causa `context` en muchos componentes | Context demasiado amplio | Dividir el context o memoizar `value` |
| `stable: false` | Conteos distintos entre ejecuciones | Añadir `waitFor` o mockear lo no determinista |

Documentación completa (configuración, CLI, Action, API): [README.md](README.md).
Plan del proyecto: [docs/PLAN.es.md](docs/PLAN.es.md) · Marketplaces: [docs/MARKETPLACES.es.md](docs/MARKETPLACES.es.md).

## Licencia

[MIT](LICENSE) © Edwin Jorge
