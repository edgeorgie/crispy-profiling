# Evaluación: ideas y marketplaces de agentes / skills de IA

> Fecha de la evaluación: octubre 2026. Las cifras de los marketplaces cambian rápido; se citan
> como orden de magnitud, con fuente.

## 1. Ideas evaluadas

Criterios (1–5): **Demanda** (dolor real y frecuente), **Hueco** (poca competencia directa),
**Encaje** (React/TS, experiencia en Mercado Libre), **Distribución** (cuántos marketplaces
lo aceptan de forma nativa), **Esfuerzo** (5 = MVP en días).

| # | Idea | Demanda | Hueco | Encaje | Distribución | Esfuerzo | Total |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **A** | **crispy-profiling**: profiling determinista de re-renders de React para agentes + CI (CLI, MCP, Skill, plugin, Action) | 5 | 4 | 5 | 5 | 4 | **23** |
| B | Linter / scanner de seguridad para `SKILL.md` y plugins | 4 | 1 | 3 | 4 | 5 | 17 |
| C | MCP genérico de performance web (Lighthouse / Web Vitals) | 4 | 1 | 4 | 4 | 4 | 17 |
| D | Skills pack de buenas prácticas React/TS en español/portugués | 3 | 3 | 5 | 4 | 5 | 20 |
| E | Regresión de accesibilidad (axe) orientada a agentes | 4 | 2 | 4 | 4 | 4 | 18 |

**Por qué A gana**

- **Competencia** — [React Scan](https://github.com/aidenybai/react-scan) es
  visual e interactivo; [Reassure](https://oss.callstack.com/reassure/docs/introduction) mide en
  jsdom con Testing Library (nivel componente, no flujo real); la comprobación de renders de
  [Meticulous](https://app.meticulous.ai/docs/built-in-checks/react-component-renders) es de pago;
  [Chrome DevTools MCP](https://www.f22labs.com/blogs/chrome-devtools-mcp-how-ai-agents-debug-the-browser-natively/)
  y [lighthouse-mcp-server](https://github.com/danielsogl/lighthouse-mcp-server) dan trazas y Web
  Vitals, pero no el *por qué* por componente. Nadie ofrece **conteos deterministas + causa +
  props cambiadas + presupuestos + diff de baseline** en un solo paquete pensado para agentes.
- **Determinismo** — los agentes necesitan una señal que no sea ruido: los conteos de render no
  dependen de la máquina, los tiempos sí. Por eso los tiempos son opcionales (`timings: true`).
- **Encaje** — React/TS a escala (Mercado Libre) es exactamente donde los re-renders duelen.
- **Una base de código, cinco canales** — npm, MCP Registry, Agent Skills, plugin de Claude Code y
  GitHub Marketplace (Action).

**Descartadas**

- **B** está saturada: [skill-check](https://github.com/thedaviddias/skill-check),
  [Skillmark Lint](https://github.com/marketplace/actions/skillmark-lint),
  [skills-lint](https://github.com/marketplace/actions/skills-lint-skill-md-linter),
  [skillmd](https://github.com/skillmds/skillmd),
  [skillscan-lint](https://github.com/kurtpayne/skillscan-lint), entre otros.
- **C** ya la cubren Chrome DevTools MCP (oficial de Google) y varios servidores Lighthouse.
- **D** es buena idea de *segunda* skill dentro de este mismo repo (ver roadmap, fase 5).
- **E** existe en gran parte con axe-core + Playwright; poco diferencial.

## 2. Marketplaces y directorios

### 2.1 Agent Skills (`SKILL.md`, estándar abierto)

El formato `SKILL.md` es un estándar abierto ([agentskills.io](https://agentskills.io)); según el
[informe del ecosistema 2026](https://agentman.ai/blog/agent-skills-ecosystem-report-2026), unas 40
herramientas lo soportan (Claude, Codex, Copilot, VS Code, Cursor, Gemini CLI, Goose, OpenCode…).
Una sola skill sirve para todos.

| Directorio | Cómo se entra | Esfuerzo | Valor |
| --- | --- | --- | --- |
| [skills.sh](https://skills.sh/docs) (Vercel) | Automático: el repo se indexa cuando alguien hace `npx skills add edgeorgie/crispy-profilling`; el ranking sale de la telemetría de instalaciones ([FAQ](https://skills.sh/docs/faq)) | Nulo | **Alto** (el más usado para descubrir) |
| SkillsMP, SkillHub, claudemarket.ai, aitmpl.com | Indexan GitHub (crawling) | Nulo | Medio |
| [awesome-claude-plugins / listas awesome](https://awesomeclaudeplugins.com) | PR a la lista | Bajo | Medio (SEO, backlinks) |

Requisito cubierto: estructura `skills/<nombre>/SKILL.md` con frontmatter `name` + `description`.

### 2.2 Servidores MCP

Hay un **registro canónico** y marketplaces encima que consumen sus datos
([comparativa 2026](https://designrevision.com/blog/best-mcp-marketplaces-and-registries)):

| Destino | Cómo se entra | Esfuerzo | Valor |
| --- | --- | --- | --- |
| **[Official MCP Registry](https://registry.modelcontextprotocol.io)** (Anthropic, GitHub, Microsoft, PulseMCP) | `server.json` + `mcpName` en package.json + `mcp-publisher publish` con OIDC de GitHub Actions (ya automatizado en `release.yml`) | Ya hecho | **Muy alto**: alimenta a VS Code / GitHub, PulseMCP y otros |
| [Glama](https://glama.ai/mcp/servers) (~21k servidores) | Indexa GitHub; se puede reclamar la ficha | Bajo | Alto |
| [mcp.so](https://mcp.so) (~20k) | Formulario / issue | Bajo | Medio |
| [Smithery](https://smithery.ai) (~7–8k, hosting) | `smithery.yaml` o publicar desde su web | Bajo | Medio (más orientado a servidores remotos) |
| [PulseMCP](https://www.pulsemcp.com) | Lee el registro oficial | Nulo | Medio |
| Docker MCP Catalog | PR a `docker/mcp-registry` con imagen | Medio | Bajo para este caso (necesita navegador en la imagen) |

### 2.3 Plugins de Claude Code

| Destino | Cómo se entra | Esfuerzo | Valor |
| --- | --- | --- | --- |
| **Marketplace propio** (este repo) | `.claude-plugin/marketplace.json` ya creado; los usuarios hacen `/plugin marketplace add edgeorgie/crispy-profilling` | Ya hecho | Alto |
| **[Directorio de Anthropic](https://claude.ai/directory)** | Portal [claude.ai/directory/manage](https://claude.ai/directory/manage); requiere plan de pago de claude.ai; revisión manual ([docs](https://code.claude.com/docs/en/plugins/publish)) | Bajo (tú) | **Muy alto**: llega a claude.ai, Cowork y Claude Code |
| [claudemarketplaces.com](https://claudemarketplaces.com) (>2.500 marketplaces) | Indexa repos con `marketplace.json` | Nulo | Medio |

### 2.4 Otros canales

| Destino | Cómo | Valor |
| --- | --- | --- |
| npm (`crispy-profiling`) | `release.yml` publica con *provenance* | Base de todo lo demás |
| GitHub Marketplace (Actions) | `action.yml` ya en la raíz; marcar "Publish to Marketplace" al crear un release | Alto para CI |
| Cursor / VS Code | Se alimentan del MCP Registry y de skills | Automático |

## 3. Conclusión

Publicar en **4 sitios activos** (npm, MCP Registry, directorio de Anthropic, GitHub Marketplace)
cubre automáticamente al resto (skills.sh, Glama, PulseMCP, VS Code, claudemarketplaces…). Todo
excepto los pasos que exigen tu identidad (cuenta npm, plan claude.ai, aceptar términos de GitHub
Marketplace) ya está automatizado en este repositorio.
